import { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
type WebGL2DanmakuCanvas = HTMLCanvasElement | OffscreenCanvas;
export default class WebGL2DanmakuBatchRenderer {
    private readonly canvas;
    private readonly gl;
    private readonly program;
    private readonly resolutionLocation;
    private readonly opacityLocation;
    private readonly vertexBuffer;
    private readonly instanceBuffer;
    private readonly pages;
    private readonly instances;
    private readonly defaultAtlasSize;
    private readonly maximumAtlasSize;
    private pixelRatio;
    constructor(canvas: WebGL2DanmakuCanvas);
    resize(width: number, height: number, pixelRatio: number): void;
    createSprite(source: TexImageSource, width: number, height: number): WebGLDanmakuSprite;
    deleteSprite(sprite: WebGLDanmakuSprite | undefined): void;
    beginFrame(opacity: number): void;
    drawSprite(sprite: WebGLDanmakuSprite, x: number, y: number, color?: [number, number, number, number]): void;
    endFrame(): void;
    clear(): void;
    private allocate;
    private allocateFromPage;
    private createPage;
    private createProgram;
    private compileShader;
    private requireUniform;
}
export {};
//# sourceMappingURL=webgl2-danmaku-batch-renderer.d.ts.map