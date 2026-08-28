import DPlayer from './player';
import Events from './events';
import * as DPlayerType from './types';
import WebGLDanmakuRenderer, { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
import WebGLDanmakuWorkerRenderer from './webgl-danmaku-worker-renderer';
interface DanmakuOptions {
    player: DPlayer;
    container: HTMLElement;
    opacity: number;
    callback: () => void;
    error: (msg: string) => void;
    apiBackend: DPlayerType.APIBackend;
    borderColor: string;
    fontSize: number;
    time: () => number;
    unlimited: number;
    speedRate: number;
    api: DanmakuOptionsAPI;
    events: Events;
    tran: (msg: string) => string;
}
interface DanmakuOptionsAPI {
    id?: string;
    address?: string;
    token?: string;
    maximum?: number;
    addition?: string[];
    user?: string;
}
interface DanmakuTunnelItem {
    element: HTMLElement | null;
    width: number;
    startedAt: number;
    startedMediaTime: number | null;
    duration: number;
    renderedElapsed?: number;
}
interface CanvasDanmakuItem {
    workerId: number;
    type: DPlayerType.DanmakuType;
    x: number;
    y: number;
    startX: number;
    endX: number;
    bitmap: HTMLCanvasElement;
    bitmapWidth: number;
    bitmapHeight: number;
    bitmapPadding: number;
    webglSprite?: WebGLDanmakuSprite;
    placement: DanmakuTunnelPlacement;
}
interface DanmakuTunnelPlacement {
    lane: number;
    item: DanmakuTunnelItem;
}
declare class Danmaku {
    options: DanmakuOptions;
    player: DPlayer;
    container: HTMLElement;
    danTunnel: {
        right: {
            [key: string]: DanmakuTunnelItem[];
        };
        top: {
            [key: string]: DanmakuTunnelItem[];
        };
        bottom: {
            [key: string]: DanmakuTunnelItem[];
        };
    };
    danIndex: number;
    dan: DPlayerType.Dan[];
    _opacity: number;
    events: Events;
    unlimited: boolean;
    measureContexts: Map<number, CanvasRenderingContext2D>;
    showing: boolean;
    paused: boolean;
    containerWidth: number;
    containerHeight: number;
    canvas: HTMLCanvasElement | null;
    canvasContext: CanvasRenderingContext2D | null;
    webglRenderer: WebGLDanmakuRenderer | null;
    workerRenderer: WebGLDanmakuWorkerRenderer | null;
    canvasItems: Set<CanvasDanmakuItem>;
    canvasPausedAt: number | null;
    nextWorkerId: number;
    mediaWaiting: boolean;
    nextCanvasRenderAt: number;
    constructor(options: DanmakuOptions);
    load(): void;
    reload(newAPI: DanmakuOptionsAPI): void;
    /**
     * Asynchronously read danmaku from all API endpoints
     */
    _readAllEndpoints(endpoints: string[], callback: (results: DPlayerType.Dan[][]) => void): void;
    send(dan: DPlayerType.DanmakuItem, callback: () => void, isCallbackOnError?: boolean): void;
    frame(): void;
    opacity(percentage?: number): number;
    /**
     * Push a danmaku into DPlayer
     *
     * @param {Object Array} dan - {text, color, type}
     * text - danmaku content
     * color - danmaku color, default: `#ffeaea`
     * type - danmaku type, `right` `top` `bottom`, default: `right`
     * size - danmaku size, `medium` `big` `small`, default: `medium`
     */
    draw(dan: DPlayerType.DanmakuItem | DPlayerType.DanmakuItem[] | DPlayerType.Dan[]): DocumentFragment | null;
    private initCanvas;
    private createCanvas;
    private initMainThreadRenderer;
    private fallbackFromWorker;
    private resizeCanvas;
    private clearCanvas;
    private drawCanvas;
    private renderCanvas;
    private createCanvasDanmakuBitmap;
    private removeCanvasItem;
    private removeExpiredWorkerItems;
    play(): void;
    pause(): void;
    private getMediaTimeMilliseconds;
    private syncWorkerClock;
    _measure(text: string, itemFontSize: number): number;
    seek(): void;
    clear(): void;
    resize(): void;
    hide(): void;
    show(): void;
    toggle(): void;
    unlimit(boolean: boolean): void;
    speed(rate: number): void;
    _danAnimation(position: DPlayerType.DanmakuType): string;
}
export default Danmaku;
//# sourceMappingURL=danmaku.d.ts.map