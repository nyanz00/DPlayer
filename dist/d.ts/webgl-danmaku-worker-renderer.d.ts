import { WorkerDanmakuItem, WorkerDanmakuRenderStats, WorkerFrameTiming } from './webgl-danmaku-worker-protocol';
interface WorkerRendererOptions {
    width: number;
    height: number;
    pixelRatio: number;
    opacity: number;
    frameTiming: WorkerFrameTiming;
    batch: boolean;
    onExpired: (ids: number[]) => void;
    onStats: (stats: WorkerDanmakuRenderStats) => void;
    onError: (error: Error) => void;
}
export default class WebGLDanmakuWorkerRenderer {
    private readonly options;
    private readonly worker;
    private readonly activeIds;
    private destroyed;
    private lastClockSyncAt;
    static isSupported(canvas: HTMLCanvasElement): boolean;
    constructor(canvas: HTMLCanvasElement, options: WorkerRendererOptions);
    add(item: WorkerDanmakuItem, source: HTMLCanvasElement): void;
    remove(id: number): void;
    resize(width: number, height: number, pixelRatio: number): void;
    opacity(value: number): void;
    frameTiming(value: WorkerFrameTiming): void;
    syncClock(mediaTime: number | null, playing: boolean, playbackRate: number, force?: boolean): void;
    clear(): void;
    destroy(): void;
    private post;
}
export {};
//# sourceMappingURL=webgl-danmaku-worker-renderer.d.ts.map