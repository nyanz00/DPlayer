import { WebGLDanmakuWorkerInput, WebGLDanmakuWorkerOutput, WorkerDanmakuItem, WorkerDanmakuRenderStats, WorkerFrameTiming } from './webgl-danmaku-worker-protocol';
import DanmakuWorker from 'worker-loader?inline=no-fallback!./webgl-danmaku-worker';

interface WorkerRendererOptions {
    width: number,
    height: number,
    pixelRatio: number,
    opacity: number,
    frameTiming: WorkerFrameTiming,
    batch: boolean,
    onExpired: (ids: number[]) => void,
    onStats: (stats: WorkerDanmakuRenderStats) => void,
    onBitmapPrepared: (durationMs: number) => void,
    onError: (error: Error) => void,
}

export default class WebGLDanmakuWorkerRenderer {
    private readonly worker: Worker;
    private readonly activeIds = new Set<number>();
    private destroyed = false;
    private lastClockSyncAt = -Infinity;

    static isSupported(canvas: HTMLCanvasElement): boolean {
        return typeof Worker !== 'undefined'
            && typeof createImageBitmap === 'function'
            && typeof canvas.transferControlToOffscreen === 'function';
    }

    constructor(canvas: HTMLCanvasElement, private readonly options: WorkerRendererOptions) {
        if (!WebGLDanmakuWorkerRenderer.isSupported(canvas)) throw new Error('OffscreenCanvas Worker rendering is not supported');
        this.worker = new DanmakuWorker();
        this.worker.onmessage = (event: MessageEvent<WebGLDanmakuWorkerOutput>): void => {
            if (event.data.type === 'expired') {
                event.data.ids.forEach(id => this.activeIds.delete(id));
                this.options.onExpired(event.data.ids);
            } else if (event.data.type === 'stats') {
                this.options.onStats(event.data.value);
            } else if (event.data.type === 'error') {
                this.options.onError(new Error(event.data.message));
            }
        };
        this.worker.onerror = (event): void => this.options.onError(new Error(event.message || 'Danmaku Worker failed'));
        try {
            const offscreen = canvas.transferControlToOffscreen();
            this.post({
                type: 'init',
                canvas: offscreen,
                width: options.width,
                height: options.height,
                pixelRatio: options.pixelRatio,
                opacity: options.opacity,
                frameTiming: options.frameTiming,
                batch: options.batch,
            }, [offscreen]);
        } catch (error) {
            this.destroy();
            throw error;
        }
    }

    add(item: WorkerDanmakuItem, source: HTMLCanvasElement): void {
        this.activeIds.add(item.id);
        const startedAt = performance.now();
        createImageBitmap(source).then(bitmap => {
            if (this.destroyed || !this.activeIds.has(item.id)) {
                bitmap.close();
                return;
            }
            this.options.onBitmapPrepared(performance.now() - startedAt);
            this.post({ type: 'add', item, bitmap }, [bitmap]);
        }).catch(error => this.options.onError(error instanceof Error ? error : new Error(String(error))));
    }

    remove(id: number): void {
        if (!this.activeIds.delete(id)) return;
        this.post({ type: 'remove', id });
    }

    resize(width: number, height: number, pixelRatio: number): void {
        this.post({ type: 'resize', width, height, pixelRatio });
    }

    opacity(value: number): void {
        this.post({ type: 'opacity', value });
    }

    frameTiming(value: WorkerFrameTiming): void {
        this.post({ type: 'frameTiming', value });
    }

    syncClock(mediaTime: number | null, playing: boolean, playbackRate: number, force = false): void {
        const now = performance.now();
        if (!force && now - this.lastClockSyncAt < 250) return;
        this.lastClockSyncAt = now;
        this.post({
            type: 'clock',
            mediaTime,
            sampledAt: performance.timeOrigin + now,
            playing,
            playbackRate,
        });
    }

    clear(): void {
        this.activeIds.clear();
        this.post({ type: 'clear' });
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.activeIds.clear();
        this.worker.terminate();
    }

    private post(message: WebGLDanmakuWorkerInput, transfer: Transferable[] = []): void {
        if (!this.destroyed) this.worker.postMessage(message, transfer);
    }
}
