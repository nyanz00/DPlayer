import { WebGLDanmakuWorkerInput, WebGLDanmakuWorkerOutput, WorkerDanmakuItem } from './webgl-danmaku-worker-protocol';
import DanmakuWorker from 'worker-loader?inline=no-fallback!./webgl-danmaku-worker';

interface WorkerRendererOptions {
    width: number,
    height: number,
    pixelRatio: number,
    opacity: number,
    debugMotion: boolean,
    onExpired: (ids: number[]) => void,
    onError: (error: Error) => void,
}

export default class WebGLDanmakuWorkerRenderer {
    private readonly worker: Worker;
    private readonly activeIds = new Set<number>();

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
            } else if (event.data.type === 'error') {
                this.options.onError(new Error(event.data.message));
            }
        };
        this.worker.onerror = (event): void => this.options.onError(new Error(event.message || 'Danmaku Worker failed'));
        const offscreen = canvas.transferControlToOffscreen();
        this.post({
            type: 'init',
            canvas: offscreen,
            width: options.width,
            height: options.height,
            pixelRatio: options.pixelRatio,
            opacity: options.opacity,
            debugMotion: options.debugMotion,
        }, [offscreen]);
    }

    add(item: WorkerDanmakuItem, source: HTMLCanvasElement): void {
        this.activeIds.add(item.id);
        createImageBitmap(source).then(bitmap => {
            if (!this.activeIds.has(item.id)) {
                bitmap.close();
                return;
            }
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

    pause(): void { this.post({ type: 'pause' }); }
    play(): void { this.post({ type: 'play' }); }

    clear(): void {
        this.activeIds.clear();
        this.post({ type: 'clear' });
    }

    destroy(): void {
        this.activeIds.clear();
        this.worker.terminate();
    }

    private post(message: WebGLDanmakuWorkerInput, transfer: Transferable[] = []): void {
        this.worker.postMessage(message, transfer);
    }
}
