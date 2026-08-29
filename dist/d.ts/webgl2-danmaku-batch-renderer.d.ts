import { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
export interface WebGL2BatchMotion {
    id: number;
    startX: number;
    endX: number;
    y: number;
    padding: number;
    duration: number;
    startedAt: number;
}
export interface WebGL2BatchFrameStats {
    drawCalls: number;
    gpuTimeMs: number | null;
}
type WebGL2DanmakuCanvas = HTMLCanvasElement | OffscreenCanvas;
export default class WebGL2DanmakuBatchRenderer {
    private readonly canvas;
    private readonly gl;
    private readonly program;
    private readonly resolutionLocation;
    private readonly opacityLocation;
    private readonly clockLocation;
    private readonly pages;
    private readonly defaultAtlasSize;
    private readonly maximumAtlasSize;
    private readonly timerQueryExtension;
    private pixelRatio;
    private activeTimerQuery;
    private pendingTimerQuery;
    private framesUntilTimerQuery;
    private latestGpuTimeMs;
    private latestDrawCalls;
    constructor(canvas: WebGL2DanmakuCanvas);
    resize(width: number, height: number, pixelRatio: number): void;
    createSprite(source: TexImageSource, width: number, height: number): WebGLDanmakuSprite;
    registerSprite(sprite: WebGLDanmakuSprite, motion: WebGL2BatchMotion): void;
    deleteSprite(sprite: WebGLDanmakuSprite | undefined): void;
    beginFrame(opacity: number, clock?: number): void;
    drawSprite(): void;
    endFrame(): void;
    clear(): void;
    getFrameStats(): WebGL2BatchFrameStats;
    private rebuildInstanceBuffer;
    private bindInstanceBuffer;
    private pollTimerQuery;
    private beginTimerQuery;
    private endTimerQuery;
    private allocate;
    private allocateFromPage;
    private createPage;
    private createProgram;
    private compileShader;
    private requireUniform;
}
export {};
//# sourceMappingURL=webgl2-danmaku-batch-renderer.d.ts.map