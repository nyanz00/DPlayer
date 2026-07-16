export interface WorkerDanmakuItem {
    id: number,
    type: 'right' | 'top' | 'bottom',
    startX: number,
    endX: number,
    y: number,
    width: number,
    height: number,
    padding: number,
    duration: number,
    elapsed: number,
}

export type WebGLDanmakuWorkerInput =
    | { type: 'init', canvas: OffscreenCanvas, width: number, height: number, pixelRatio: number, opacity: number, debugMotion: boolean }
    | { type: 'add', item: WorkerDanmakuItem, bitmap: ImageBitmap }
    | { type: 'remove', id: number }
    | { type: 'resize', width: number, height: number, pixelRatio: number }
    | { type: 'opacity', value: number }
    | { type: 'pause' }
    | { type: 'play' }
    | { type: 'clear' };

export type WebGLDanmakuWorkerOutput =
    | { type: 'ready' }
    | { type: 'expired', ids: number[] }
    | { type: 'error', message: string };
