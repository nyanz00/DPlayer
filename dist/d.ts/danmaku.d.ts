import DPlayer from './player';
import Events from './events';
import * as DPlayerType from './types';
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
    element: HTMLElement;
    width: number;
    startedAt: number;
    duration: number;
    animation?: Animation;
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
    animations: Set<Animation>;
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
    play(): void;
    pause(): void;
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