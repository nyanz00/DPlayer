import WebGLDanmakuRenderer, { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
import { WebGLDanmakuWorkerInput, WebGLDanmakuWorkerOutput, WorkerDanmakuItem } from './webgl-danmaku-worker-protocol';

interface ActiveItem extends WorkerDanmakuItem {
    sprite: WebGLDanmakuSprite,
    startedAt: number,
    renderedElapsed: number,
    lastRenderedAt?: number,
    lastDrawX?: number,
}

interface WorkerScope {
    onmessage: ((event: MessageEvent<WebGLDanmakuWorkerInput>) => void) | null,
    postMessage(message: WebGLDanmakuWorkerOutput): void,
    requestAnimationFrame?: (callback: FrameRequestCallback) => number,
    setTimeout(handler: () => void, timeout?: number): number,
}

const scope = globalThis as unknown as WorkerScope;
const items = new Map<number, ActiveItem>();
let renderer: WebGLDanmakuRenderer | null = null;
let opacity = 1;
let debugMotion = false;
let pausedAt: number | null = null;
let scheduled = false;

const post = (message: WebGLDanmakuWorkerOutput): void => scope.postMessage(message);

const scheduleFrame = (): void => {
    if (scheduled) return;
    scheduled = true;
    const callback = (now: number): void => {
        scheduled = false;
        render(now);
        scheduleFrame();
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

const render = (now: number): void => {
    if (!renderer) return;
    renderer.beginFrame(opacity);
    const expired: number[] = [];
    const frameNow = pausedAt ?? now;
    const pixelRatio = Math.min(2, Math.max(1, globalPixelRatio));

    for (const item of items.values()) {
        const targetElapsed = Math.max(0, frameNow - item.startedAt);
        const frameElapsed = item.lastRenderedAt === undefined
            ? Math.min(targetElapsed, 1000 / 60)
            : Math.max(0, frameNow - item.lastRenderedAt);
        const baseAdvance = Math.min(frameElapsed, 1000 / 30);
        const delayed = Math.max(0, targetElapsed - item.renderedElapsed - baseAdvance);
        const catchUp = Math.min(delayed * 0.12, baseAdvance * 0.25);
        const elapsed = Math.min(targetElapsed, item.renderedElapsed + baseAdvance + catchUp);
        item.renderedElapsed = elapsed;
        item.lastRenderedAt = frameNow;
        if (elapsed >= item.duration) {
            expired.push(item.id);
            continue;
        }

        const x = item.type === 'right'
            ? item.startX + (item.endX - item.startX) * (elapsed / item.duration)
            : item.startX;
        const drawX = Math.round((x - item.padding) * pixelRatio) / pixelRatio;
        const drawY = Math.round((item.y - item.padding) * pixelRatio) / pixelRatio;
        const regressed = item.type === 'right' && item.lastDrawX !== undefined && drawX > item.lastDrawX;
        item.lastDrawX = drawX;
        renderer.drawSprite(item.sprite, drawX, drawY);
        if (debugMotion && item.type === 'right') {
            renderer.drawDebugMarker(drawX, drawY + item.padding, item.height - item.padding * 2, regressed);
        }
    }

    if (expired.length) {
        expired.forEach(deleteItem);
        post({ type: 'expired', ids: expired });
    }
};

let globalPixelRatio = 1;

scope.onmessage = (event): void => {
    try {
        const message = event.data;
        switch (message.type) {
        case 'init':
            renderer = new WebGLDanmakuRenderer(message.canvas);
            globalPixelRatio = message.pixelRatio;
            opacity = message.opacity;
            debugMotion = message.debugMotion;
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
                startedAt: now - message.item.elapsed,
                renderedElapsed: message.item.elapsed,
                lastRenderedAt: now,
            });
            break;
        }
        case 'remove':
            deleteItem(message.id);
            break;
        case 'resize':
            globalPixelRatio = message.pixelRatio;
            renderer?.resize(message.width, message.height, message.pixelRatio);
            break;
        case 'opacity':
            opacity = message.value;
            break;
        case 'pause':
            if (pausedAt === null) pausedAt = performance.now();
            break;
        case 'play':
            if (pausedAt !== null) {
                const now = performance.now();
                const duration = now - pausedAt;
                for (const item of items.values()) {
                    item.startedAt += duration;
                    item.lastRenderedAt = now;
                }
                pausedAt = null;
            }
            break;
        case 'clear':
            for (const id of [...items.keys()]) deleteItem(id);
            renderer?.clear();
            pausedAt = null;
            break;
        }
    } catch (error) {
        post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
};
