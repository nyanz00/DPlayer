import WebGLDanmakuRenderer, { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
import WebGL2DanmakuBatchRenderer from './webgl2-danmaku-batch-renderer';
import { WebGLDanmakuWorkerInput, WebGLDanmakuWorkerOutput, WorkerDanmakuItem, WorkerFrameTiming } from './webgl-danmaku-worker-protocol';

interface ActiveItem extends WorkerDanmakuItem {
    sprite: WebGLDanmakuSprite,
    fallbackStartedAt: number,
    renderedElapsed: number,
    animationStartedAt: number,
}

interface WorkerScope {
    onmessage: ((event: MessageEvent<WebGLDanmakuWorkerInput>) => void) | null,
    postMessage(message: WebGLDanmakuWorkerOutput): void,
    requestAnimationFrame?: (callback: FrameRequestCallback) => number,
    setTimeout(handler: () => void, timeout?: number): number,
}

const scope = globalThis as unknown as WorkerScope;
const DEFAULT_FRAME_INTERVAL = 1000 / 60;
const FRAME_DEADLINE_TOLERANCE = 0.5;
const items = new Map<number, ActiveItem>();
let renderer: WebGLDanmakuRenderer | WebGL2DanmakuBatchRenderer | null = null;
let opacity = 1;
let pixelRatio = 1;
let mediaAnchor: number | null = null;
let mediaAnchorAt = 0;
let mediaPlaying = false;
let playbackRate = 1;
let lastSampledMediaTime: number | null = null;
let animationAnchor = 0;
let animationAnchorAt = 0;
let scheduled = false;
let nextRenderAt = 0;
let frameDivisor: number | null = null;
let frameInterval = DEFAULT_FRAME_INTERVAL;
let framesUntilRender = 0;
let statsStartedAt = 0;
let lastFrameCallbackAt: number | null = null;
let frameIntervals: number[] = [];
let renderedFrames = 0;
let textureUploadTotalMs = 0;
let textureUploadMaxMs = 0;
let textureUploadCount = 0;

const post = (message: WebGLDanmakuWorkerOutput): void => scope.postMessage(message);

const estimatedMediaTime = (now: number): number | null => {
    if (mediaAnchor === null) return null;
    return mediaAnchor + (mediaPlaying ? Math.max(0, now - mediaAnchorAt) * playbackRate : 0);
};

const estimatedAnimationTime = (now: number): number => animationAnchor
    + (mediaPlaying ? Math.max(0, now - animationAnchorAt) * playbackRate : 0);

const sampleFrameCallback = (now: number): void => {
    if (lastFrameCallbackAt !== null && now > lastFrameCallbackAt) frameIntervals.push(now - lastFrameCallbackAt);
    lastFrameCallbackAt = now;
    if (statsStartedAt === 0) statsStartedAt = now;
    if (now - statsStartedAt < 1000 || frameIntervals.length === 0 || !(renderer instanceof WebGL2DanmakuBatchRenderer)) return;
    const sorted = [...frameIntervals].sort((a, b) => a - b);
    const total = frameIntervals.reduce((sum, interval) => sum + interval, 0);
    const statsDuration = now - statsStartedAt;
    const frameStats = renderer.getFrameStats();
    post({
        type: 'stats',
        value: {
            mode: 'webgl2-batch',
            rafFps: total > 0 ? frameIntervals.length * 1000 / total : 0,
            rafIntervalAverageMs: total / frameIntervals.length,
            rafIntervalP95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
            rafIntervalP99Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))],
            rafIntervalMaxMs: sorted[sorted.length - 1],
            rafIntervalsOver14Ms: frameIntervals.filter(interval => interval >= 14).length,
            renderFps: statsDuration > 0 ? renderedFrames * 1000 / statsDuration : 0,
            gpuTimeMs: frameStats.gpuTimeMs,
            activeComments: items.size,
            drawCalls: frameStats.drawCalls,
            textureUploadAverageMs: textureUploadCount > 0 ? textureUploadTotalMs / textureUploadCount : 0,
            textureUploadMaxMs,
            textureUploadCount,
        },
    });
    statsStartedAt = now;
    frameIntervals = [];
    renderedFrames = 0;
    textureUploadTotalMs = 0;
    textureUploadMaxMs = 0;
    textureUploadCount = 0;
};

const resetFrameSamples = (): void => {
    statsStartedAt = 0;
    lastFrameCallbackAt = null;
    frameIntervals = [];
    renderedFrames = 0;
    textureUploadTotalMs = 0;
    textureUploadMaxMs = 0;
    textureUploadCount = 0;
};

const scheduleFrame = (): void => {
    if (scheduled || items.size === 0) return;
    scheduled = true;
    const callback = (now: number): void => {
        scheduled = false;
        sampleFrameCallback(now);
        const shouldRender = scope.requestAnimationFrame && frameDivisor !== null
            ? framesUntilRender === 0
            : nextRenderAt === 0 || now + FRAME_DEADLINE_TOLERANCE >= nextRenderAt;
        if (shouldRender) {
            render(now);
            renderedFrames++;
            if (scope.requestAnimationFrame && frameDivisor !== null) {
                framesUntilRender = frameDivisor - 1;
            } else {
                if (nextRenderAt === 0) nextRenderAt = now + frameInterval;
                else {
                    do {
                        nextRenderAt += frameInterval;
                    } while (nextRenderAt <= now + FRAME_DEADLINE_TOLERANCE);
                }
            }
        } else if (scope.requestAnimationFrame && frameDivisor !== null) {
            framesUntilRender--;
        }
        if (items.size > 0) scheduleFrame();
    };
    if (scope.requestAnimationFrame) scope.requestAnimationFrame(callback);
    else scope.setTimeout(() => callback(performance.now()), frameInterval);
};

const setFrameTiming = (timing: WorkerFrameTiming): void => {
    frameDivisor = timing.frameDivisor;
    frameInterval = timing.frameInterval;
    framesUntilRender = 0;
    nextRenderAt = 0;
};

const deleteItem = (id: number): void => {
    const item = items.get(id);
    if (!item) return;
    renderer?.deleteSprite(item.sprite);
    items.delete(id);
    if (items.size === 0) resetFrameSamples();
};

const expireAll = (): void => {
    const expired = [...items.keys()];
    expired.forEach(deleteItem);
    if (items.size === 0) nextRenderAt = 0;
    if (expired.length) post({ type: 'expired', ids: expired });
};

const render = (now: number): void => {
    if (!renderer) return;
    const batchRenderer = renderer instanceof WebGL2DanmakuBatchRenderer ? renderer : null;
    const animationTime = estimatedAnimationTime(now);
    if (batchRenderer) batchRenderer.beginFrame(opacity, animationTime);
    else renderer.beginFrame(opacity);
    const currentMediaTime = estimatedMediaTime(now);
    const expired: number[] = [];

    for (const item of items.values()) {
        if (batchRenderer) {
            if (animationTime - item.animationStartedAt >= item.duration) expired.push(item.id);
            continue;
        }
        const mediaElapsed = currentMediaTime !== null && item.startedMediaTime !== null
            ? currentMediaTime - item.startedMediaTime
            : null;
        const elapsed = Math.max(
            item.renderedElapsed,
            mediaElapsed === null ? now - item.fallbackStartedAt : mediaElapsed,
        );
        item.renderedElapsed = elapsed;
        if (elapsed >= item.duration) {
            expired.push(item.id);
            continue;
        }

        const x = item.type === 'right'
            ? item.startX + (item.endX - item.startX) * (elapsed / item.duration)
            : item.startX;
        const drawX = Math.round((x - item.padding) * pixelRatio) / pixelRatio;
        const drawY = Math.round((item.y - item.padding) * pixelRatio) / pixelRatio;
        renderer.drawSprite(item.sprite, drawX, drawY);
    }
    renderer.endFrame();

    if (expired.length) {
        expired.forEach(deleteItem);
        if (items.size === 0) nextRenderAt = 0;
        post({ type: 'expired', ids: expired });
    }
};

scope.onmessage = (event): void => {
    try {
        const message = event.data;
        switch (message.type) {
        case 'init':
            setFrameTiming(message.frameTiming);
            renderer = message.batch
                ? new WebGL2DanmakuBatchRenderer(message.canvas)
                : new WebGLDanmakuRenderer(message.canvas);
            pixelRatio = message.pixelRatio;
            opacity = message.opacity;
            animationAnchorAt = performance.now();
            renderer.resize(message.width, message.height, message.pixelRatio);
            post({ type: 'ready' });
            scheduleFrame();
            break;
        case 'add': {
            if (!renderer) {
                message.bitmap.close();
                break;
            }
            const textureUploadStartedAt = performance.now();
            const sprite = renderer.createSprite(message.bitmap, message.item.width, message.item.height);
            message.bitmap.close();
            const now = performance.now();
            const animationStartedAt = estimatedAnimationTime(now) - message.item.elapsed;
            const activeItem: ActiveItem = {
                ...message.item,
                sprite,
                fallbackStartedAt: now - message.item.elapsed,
                renderedElapsed: message.item.elapsed,
                animationStartedAt,
            };
            items.set(message.item.id, activeItem);
            if (renderer instanceof WebGL2DanmakuBatchRenderer) {
                renderer.registerSprite(sprite, {
                    id: message.item.id,
                    startX: message.item.startX,
                    endX: message.item.endX,
                    y: message.item.y,
                    padding: message.item.padding,
                    duration: message.item.duration,
                    startedAt: animationStartedAt,
                });
                const textureUploadDuration = performance.now() - textureUploadStartedAt;
                textureUploadTotalMs += textureUploadDuration;
                textureUploadMaxMs = Math.max(textureUploadMaxMs, textureUploadDuration);
                textureUploadCount++;
            }
            scheduleFrame();
            break;
        }
        case 'remove':
            deleteItem(message.id);
            if (items.size === 0) {
                nextRenderAt = 0;
                renderer?.clear();
            }
            break;
        case 'resize':
            pixelRatio = message.pixelRatio;
            renderer?.resize(message.width, message.height, message.pixelRatio);
            break;
        case 'opacity':
            opacity = message.value;
            break;
        case 'clock': {
            if (message.mediaTime !== null
                && lastSampledMediaTime !== null
                && message.mediaTime < lastSampledMediaTime - 250) {
                expireAll();
            }
            const now = performance.now();
            animationAnchor = estimatedAnimationTime(now);
            animationAnchorAt = now;
            const receivedAt = performance.timeOrigin + now;
            const playbackRateValue = Number.isFinite(message.playbackRate) && message.playbackRate > 0
                ? message.playbackRate
                : 1;
            const deliveryDelay = message.playing ? Math.max(0, receivedAt - message.sampledAt) * playbackRateValue : 0;
            mediaAnchor = message.mediaTime === null ? null : message.mediaTime + deliveryDelay;
            mediaAnchorAt = now;
            mediaPlaying = message.playing;
            playbackRate = playbackRateValue;
            lastSampledMediaTime = message.mediaTime;
            break;
        }
        case 'frameTiming':
            setFrameTiming(message.value);
            break;
        case 'clear':
            for (const id of [...items.keys()]) deleteItem(id);
            renderer?.clear();
            lastSampledMediaTime = null;
            nextRenderAt = 0;
            resetFrameSamples();
            break;
        }
    } catch (error) {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
};
