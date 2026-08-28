import WebGLDanmakuRenderer, { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
import { WebGLDanmakuWorkerInput, WebGLDanmakuWorkerOutput, WorkerDanmakuItem } from './webgl-danmaku-worker-protocol';

interface ActiveItem extends WorkerDanmakuItem {
    sprite: WebGLDanmakuSprite,
    fallbackStartedAt: number,
    renderedElapsed: number,
}

interface WorkerScope {
    onmessage: ((event: MessageEvent<WebGLDanmakuWorkerInput>) => void) | null,
    postMessage(message: WebGLDanmakuWorkerOutput): void,
    requestAnimationFrame?: (callback: FrameRequestCallback) => number,
    setTimeout(handler: () => void, timeout?: number): number,
}

const scope = globalThis as unknown as WorkerScope;
const FRAME_INTERVAL = 1000 / 60;
const items = new Map<number, ActiveItem>();
let renderer: WebGLDanmakuRenderer | null = null;
let opacity = 1;
let pixelRatio = 1;
let mediaAnchor: number | null = null;
let mediaAnchorAt = 0;
let mediaPlaying = false;
let playbackRate = 1;
let lastSampledMediaTime: number | null = null;
let scheduled = false;
let nextRenderAt = 0;

const post = (message: WebGLDanmakuWorkerOutput): void => scope.postMessage(message);

const estimatedMediaTime = (now: number): number | null => {
    if (mediaAnchor === null) return null;
    return mediaAnchor + (mediaPlaying ? Math.max(0, now - mediaAnchorAt) * playbackRate : 0);
};

const scheduleFrame = (): void => {
    if (scheduled || items.size === 0) return;
    scheduled = true;
    const callback = (now: number): void => {
        scheduled = false;
        if (nextRenderAt === 0 || now >= nextRenderAt) {
            render(now);
            if (nextRenderAt === 0) nextRenderAt = now + FRAME_INTERVAL;
            else {
                do {
                    nextRenderAt += FRAME_INTERVAL;
                } while (nextRenderAt <= now);
            }
        }
        if (items.size > 0) scheduleFrame();
    };
    if (scope.requestAnimationFrame) scope.requestAnimationFrame(callback);
    else scope.setTimeout(() => callback(performance.now()), 16);
};

const deleteItem = (id: number): void => {
    const item = items.get(id);
    if (!item) return;
    renderer?.deleteSprite(item.sprite);
    items.delete(id);
};

const expireAll = (): void => {
    const expired = [...items.keys()];
    expired.forEach(deleteItem);
    if (items.size === 0) nextRenderAt = 0;
    if (expired.length) post({ type: 'expired', ids: expired });
};

const render = (now: number): void => {
    if (!renderer) return;
    renderer.beginFrame(opacity);
    const currentMediaTime = estimatedMediaTime(now);
    const expired: number[] = [];

    for (const item of items.values()) {
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
            renderer = new WebGLDanmakuRenderer(message.canvas);
            pixelRatio = message.pixelRatio;
            opacity = message.opacity;
            renderer.resize(message.width, message.height, message.pixelRatio);
            post({ type: 'ready' });
            scheduleFrame();
            break;
        case 'add': {
            if (!renderer) {
                message.bitmap.close();
                break;
            }
            const sprite = renderer.createSprite(message.bitmap, message.item.width, message.item.height);
            message.bitmap.close();
            const now = performance.now();
            items.set(message.item.id, {
                ...message.item,
                sprite,
                fallbackStartedAt: now - message.item.elapsed,
                renderedElapsed: message.item.elapsed,
            });
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
        case 'clear':
            for (const id of [...items.keys()]) deleteItem(id);
            renderer?.clear();
            lastSampledMediaTime = null;
            nextRenderAt = 0;
            break;
        }
    } catch (error) {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
};
