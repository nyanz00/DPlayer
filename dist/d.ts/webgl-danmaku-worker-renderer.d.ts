import { WorkerDanmakuItem } from './webgl-danmaku-worker-protocol';
interface WorkerRendererOptions {
    width: number;
    height: number;
    pixelRatio: number;
    opacity: number;
    debugMotion: boolean;
    onExpired: (ids: number[]) => void;
    onError: (error: Error) => void;
}
export default class WebGLDanmakuWorkerRenderer {
    private readonly options;
    private readonly worker;
    private readonly activeIds;
    static isSupported(canvas: HTMLCanvasElement): boolean;
    constructor(canvas: HTMLCanvasElement, options: WorkerRendererOptions);
    add(item: WorkerDanmakuItem, source: HTMLCanvasElement): void;
    remove(id: number): void;
    resize(width: number, height: number, pixelRatio: number): void;
    opacity(value: number): void;
    pause(): void;
    play(): void;
    clear(): void;
    destroy(): void;
    private post;
}
export {};
//# sourceMappingURL=webgl-danmaku-worker-renderer.d.ts.map