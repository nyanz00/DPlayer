export interface WorkerDanmakuItem {
    id: number;
    type: 'right' | 'top' | 'bottom';
    startX: number;
    endX: number;
    y: number;
    width: number;
    height: number;
    padding: number;
    duration: number;
    startedMediaTime: number | null;
    elapsed: number;
}
export interface WorkerFrameTiming {
    frameDivisor: number | null;
    frameInterval: number;
}
export type WebGLDanmakuWorkerInput = {
    type: 'init';
    canvas: OffscreenCanvas;
    width: number;
    height: number;
    pixelRatio: number;
    opacity: number;
    frameTiming: WorkerFrameTiming;
} | {
    type: 'add';
    item: WorkerDanmakuItem;
    bitmap: ImageBitmap;
} | {
    type: 'remove';
    id: number;
} | {
    type: 'resize';
    width: number;
    height: number;
    pixelRatio: number;
} | {
    type: 'opacity';
    value: number;
} | {
    type: 'clock';
    mediaTime: number | null;
    sampledAt: number;
    playing: boolean;
    playbackRate: number;
} | {
    type: 'frameTiming';
    value: WorkerFrameTiming;
} | {
    type: 'clear';
};
export type WebGLDanmakuWorkerOutput = {
    type: 'ready';
} | {
    type: 'expired';
    ids: number[];
} | {
    type: 'error';
    message: string;
};
//# sourceMappingURL=webgl-danmaku-worker-protocol.d.ts.map