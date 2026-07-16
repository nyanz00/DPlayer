export interface WebGLDanmakuSprite {
    texture: WebGLTexture;
    width: number;
    height: number;
}
export default class WebGLDanmakuRenderer {
    private readonly canvas;
    private readonly gl;
    private readonly program;
    private readonly positionLocation;
    private readonly resolutionLocation;
    private readonly rectangleLocation;
    private readonly colorLocation;
    private readonly opacityLocation;
    private readonly whiteSprite;
    private pixelRatio;
    constructor(canvas: HTMLCanvasElement);
    resize(width: number, height: number, pixelRatio: number): void;
    createSprite(source: HTMLCanvasElement, width: number, height: number): WebGLDanmakuSprite;
    deleteSprite(sprite: WebGLDanmakuSprite | undefined): void;
    beginFrame(opacity: number): void;
    drawSprite(sprite: WebGLDanmakuSprite, x: number, y: number, color?: [number, number, number, number]): void;
    drawDebugMarker(x: number, y: number, height: number, regressed: boolean): void;
    clear(): void;
    private createProgram;
    private compileShader;
    private requireUniform;
}
//# sourceMappingURL=webgl-danmaku-renderer.d.ts.map