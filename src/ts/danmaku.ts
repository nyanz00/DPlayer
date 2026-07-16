import DPlayer from './player';
import Events from './events';
import utils from './utils';
import defaultApiBackend from './api';
import * as DPlayerType from './types';
import WebGLDanmakuRenderer, { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
import WebGLDanmakuWorkerRenderer from './webgl-danmaku-worker-renderer';

interface DanmakuOptions {
    player: DPlayer,
    container: HTMLElement,
    opacity: number,
    callback: () => void,
    error: (msg: string) => void,
    apiBackend: DPlayerType.APIBackend,
    borderColor: string,
    fontSize: number,
    renderMode: DPlayerType.DanmakuRenderMode,
    debugMotion: boolean,
    time: () => number,
    unlimited: number,
    speedRate: number,
    api: DanmakuOptionsAPI,
    events: Events,
    tran: (msg: string) => string,
}

interface DanmakuOptionsAPI {
    id?: string,
    address?: string,
    token?: string,
    maximum?: number,
    addition?: string[],
    user?: string,
}

interface DanmakuTunnelItem {
    element: HTMLElement | null,
    width: number,
    startedAt: number,
    duration: number,
    animation?: Animation,
    renderedElapsed?: number,
    lastRenderedAt?: number,
}

interface CanvasDanmakuItem {
    workerId: number,
    type: DPlayerType.DanmakuType,
    x: number,
    y: number,
    startX: number,
    endX: number,
    bitmap: HTMLCanvasElement,
    bitmapWidth: number,
    bitmapHeight: number,
    bitmapPadding: number,
    webglSprite?: WebGLDanmakuSprite,
    lastDrawX?: number,
    placement: DanmakuTunnelPlacement,
}

interface DanmakuTunnelPlacement {
    lane: number,
    item: DanmakuTunnelItem,
}

class Danmaku {
    options: DanmakuOptions;
    player: DPlayer;
    container: HTMLElement;
    danTunnel: {
        right: {[key: string]: DanmakuTunnelItem[]},
        top: {[key: string]: DanmakuTunnelItem[]},
        bottom: {[key: string]: DanmakuTunnelItem[]},
    };
    danIndex: number;
    dan: DPlayerType.Dan[];
    _opacity: number;
    events: Events;
    unlimited: boolean;

    measureContexts = new Map<number, CanvasRenderingContext2D>();
    showing: boolean;
    paused = false;
    containerWidth: number;
    containerHeight: number;
    animations = new Set<Animation>();
    canvas: HTMLCanvasElement | null = null;
    canvasContext: CanvasRenderingContext2D | null = null;
    webglRenderer: WebGLDanmakuRenderer | null = null;
    workerRenderer: WebGLDanmakuWorkerRenderer | null = null;
    canvasItems = new Set<CanvasDanmakuItem>();
    canvasPausedAt: number | null = null;
    nextWorkerId = 1;
    compositeVideos = new Set<HTMLVideoElement>();
    compositeFailed = false;

    constructor(options: DanmakuOptions) {
        this.options = options;
        this.player = this.options.player;
        this.container = this.options.container;
        this.danTunnel = {
            right: {},
            top: {},
            bottom: {},
        };
        this.danIndex = 0;
        this.dan = [];
        this.showing = true;
        this._opacity = this.options.opacity;
        this.events = this.options.events;
        this.unlimited = this.options.unlimited === 1;
        this.containerWidth = this.container.clientWidth;
        this.containerHeight = this.container.clientHeight;
        if (this.usesSurfaceRenderer()) this.initCanvas();
        this.events.on('destroy', () => {
            this.workerRenderer?.destroy();
            this.workerRenderer = null;
            this.restoreCompositeVideos();
        });
        this.load();
    }

    load(): void {
        let apiurl;
        if (this.options.api.address) {
            const apiParamsObj = Object.assign({},
                this.options.api.id ? { id: this.options.api.id } : {},
                this.options.api.maximum ? { max: this.options.api.maximum } : {},
            );
            const apiParamsStr = Object.entries(apiParamsObj)
                .map(([key, value]) => `${key}=${value}`)
                .join('&');
            apiurl = apiParamsStr ? `${this.options.api.address}?${apiParamsStr}` : this.options.api.address;
        }
        const endpoints = (this.options.api.addition || []).slice(0);
        if (apiurl) endpoints.push(apiurl);
        if (this.options.apiBackend !== defaultApiBackend) endpoints.push('apiBackend');
        this.events && this.events.trigger('danmaku_load_start', endpoints);

        this._readAllEndpoints(endpoints, (results) => {
            this.dan = ([] as DPlayerType.Dan[]).concat(...results).sort((a, b) => a.time - b.time);
            window.requestAnimationFrame(() => {
                this.frame();
            });

            this.options.callback();

            this.events && this.events.trigger('danmaku_load_end');
        });
    }

    reload(newAPI: DanmakuOptionsAPI) {
        this.options.api = newAPI;
        this.dan = [];
        this.clear();
        this.load();
    }

    /**
     * Asynchronously read danmaku from all API endpoints
     */
    _readAllEndpoints(endpoints: string[], callback: (results: DPlayerType.Dan[][]) => void): void {
        const results: DPlayerType.Dan[][] = [];
        let errorCount = 0;
        let readCount = 0;

        for (let i = 0; i < endpoints.length; ++i) {
            this.options.apiBackend.read({
                url: endpoints[i],
                success: (data) => {
                    results[i] = data;

                    ++readCount;
                    if (readCount === endpoints.length) {
                        callback(results);
                    }
                },
                error: (message) => {
                    if (message) this.options.error(message);
                    results[i] = [];

                    ++errorCount;
                    ++readCount;
                    if (readCount === endpoints.length) {
                        if (errorCount !== endpoints.length) {
                            this.options.error(this.options.tran('Danmaku load partial failed'));
                        } else {
                            this.options.error(this.options.tran('Danmaku load failed'));
                        }
                        callback(results);
                    }
                },
            });
        }
    }

    send(dan: DPlayerType.DanmakuItem, callback: () => void, isCallbackOnError = false): void {
        const danmakuData: DPlayerType.Dan = {
            token: this.options.api.token,
            id: this.options.api.id,
            author: this.options.api.user,
            time: this.options.time(),
            text: dan.text,
            color: dan.color,
            type: dan.type,
            size: dan.size,
        };

        this.options.apiBackend.send({
            url: this.options.api.address,
            data: danmakuData,
            success: () => {
                this.dan.splice(this.danIndex, 0, danmakuData);
                this.danIndex++;
                this.draw({
                    text: danmakuData.text,
                    color: danmakuData.color,
                    type: danmakuData.type,
                    size: danmakuData.size,
                    border: true,
                });

                this.events && this.events.trigger('danmaku_send', danmakuData);
                callback();
            },
            error: (message) => {
                this.options.error(message || this.options.tran('Danmaku send failed'));
                if (isCallbackOnError === true) {
                    callback();
                }
            },
        });
    }

    frame(): void {
        if (this.dan.length && !this.paused && this.showing) {
            let item = this.dan[this.danIndex];
            const dan = [];
            while (item && this.options.time() > (typeof item.time === 'number' ? item.time : parseFloat(item.time))) {
                dan.push(item);
                item = this.dan[++this.danIndex];
            }
            this.draw(dan);
        }
        if (this.usesSurfaceRenderer()) {
            this.renderCanvas(this.paused && this.canvasPausedAt !== null ? this.canvasPausedAt : performance.now());
        }
        window.requestAnimationFrame(() => {
            this.frame();
        });
    }

    opacity(percentage?: number): number {
        if (percentage !== undefined) {
            this.container.style.setProperty('--dplayer-danmaku-opacity', `${percentage}`);
            this._opacity = percentage;
            this.workerRenderer?.opacity(percentage);

            this.events && this.events.trigger('danmaku_opacity', this._opacity);
        }
        return this._opacity;
    }

    /**
     * Push a danmaku into DPlayer
     *
     * @param {Object Array} dan - {text, color, type}
     * text - danmaku content
     * color - danmaku color, default: `#ffeaea`
     * type - danmaku type, `right` `top` `bottom`, default: `right`
     * size - danmaku size, `medium` `big` `small`, default: `medium`
     */
    draw(dan: DPlayerType.DanmakuItem | DPlayerType.DanmakuItem[] | DPlayerType.Dan[]): DocumentFragment | null {
        if (this.showing) {
            if (this.usesSurfaceRenderer()) {
                this.drawCanvas(dan);
                return null;
            }

            // if the dan variable is an object, create and assign an array of only one object
            let danList: DPlayerType.DanmakuItem[] | DPlayerType.Dan[];
            if (Object.prototype.toString.call(dan) !== '[object Array]') {
                danList = [dan as DPlayerType.DanmakuItem];
            } else {
                danList = dan as DPlayerType.DanmakuItem[] | DPlayerType.Dan[];
            }

            // adjust the font size according to the screen size
            const ratioRate = 1.25; // magic!
            let ratio = this.containerWidth / 1024 * ratioRate;
            if (ratio >= 1) ratio = 1; // ratio should not exceed 1
            const baseItemFontSize = this.options.fontSize * ratio;
            const itemHeight = baseItemFontSize + (6 * ratio); // 6 is the vertical margin of danmaku

            const danWidth = this.containerWidth;
            const danHeight = this.containerHeight;
            const laneCount = Math.max(1, Math.floor(danHeight / itemHeight));

            // Keep the moving-comment collision calculation entirely numeric. Reading
            // getBoundingClientRect() here forced a synchronous layout for every active
            // comment whenever a new comment arrived, which visibly disturbed animations.
            const canShareRightLane = (previous: DanmakuTunnelItem, width: number, duration: number, now: number) => {
                const animationTime = previous.animation?.currentTime;
                const elapsed = Math.max(0, typeof animationTime === 'number' ? animationTime : now - previous.startedAt);
                if (elapsed >= previous.duration) return true;

                const progress = elapsed / previous.duration;
                const previousRight = (danWidth + previous.width) * (1 - progress);
                const gap = danWidth - previousRight;
                const minimumGap = 10;
                if (gap < minimumGap) return false;

                const previousSpeed = (danWidth + previous.width) / previous.duration;
                const nextSpeed = (danWidth + width) / duration;
                if (nextSpeed <= previousSpeed) return true;

                const remaining = previous.duration - elapsed;
                const catchUpTime = (gap - minimumGap) / (nextSpeed - previousSpeed);
                return catchUpTime >= remaining;
            };

            const getTunnel = (
                danmakuItem: HTMLElement,
                type: DPlayerType.DanmakuType,
                width: number,
                duration: number,
            ): DanmakuTunnelPlacement | null => {
                const now = performance.now();
                const tunnelItem: DanmakuTunnelItem = { element: danmakuItem, width, startedAt: now, duration };

                for (let i = 0; this.unlimited || i < laneCount; i++) {
                    const lane = this.danTunnel[type][i + ''];
                    if (lane && lane.length) {
                        if (type !== 'right') {
                            continue;
                        }
                        const previous = lane[lane.length - 1];
                        if (!canShareRightLane(previous, width, duration, now)) {
                            continue;
                        }
                        lane.push(tunnelItem);
                    } else {
                        this.danTunnel[type][i + ''] = [tunnelItem];
                    }
                    return { lane: i, item: tunnelItem };
                }
                return null;
            };

            const removeTunnelItem = (type: DPlayerType.DanmakuType, placement: DanmakuTunnelPlacement) => {
                const lane = this.danTunnel[type][placement.lane + ''];
                if (lane) {
                    const index = lane.indexOf(placement.item);
                    if (index >= 0) lane.splice(index, 1);
                }
                if (placement.item.element?.parentNode === this.container) {
                    this.container.removeChild(placement.item.element);
                }
            };

            const docFragment = document.createDocumentFragment();
            const startAnimations: Array<() => void> = [];

            for (let i = 0; i < danList.length; i++) {

                const dan = danList[i];

                // Whether the type is numeric (for compatibility)
                if (typeof dan.color === 'number' && isFinite(dan.color)) {
                    dan.color = utils.number2Color(dan.color);
                }
                if (typeof dan.type === 'number' && isFinite(dan.type)) {
                    dan.type = utils.number2Type(dan.type) as DPlayerType.DanmakuType;
                }

                // set default danmaku color
                if (!dan.color) {
                    dan.color = '#ffeaea'; // white
                }

                // set default danmaku type
                if (!dan.type || (dan.type !== 'right' && dan.type !== 'top' && dan.type !== 'bottom')) {
                    dan.type = 'right';
                }

                // set default danmaku size
                if (!dan.size) {
                    dan.size = 'medium';
                }

                // Keep the font size on each item. The previous container-wide CSS variable
                // resized every in-flight comment whenever a new big/small comment arrived.
                // Danmaku size intentionally does not affect tunnel height.
                const itemFontSize = baseItemFontSize * (dan.size === 'big' ? 1.25 : dan.size === 'small' ? 0.8 : 1);

                const itemWidth = (() => {
                    let measure = 0;
                    // returns the width of the widest line
                    for (const line of dan.text.split('\n')) {
                        const result = this._measure(line, itemFontSize);
                        if (result > measure) {
                            measure = result;
                        }
                    }
                    return measure;
                })();

                // repeat for each line of danmaku
                // if danmaku type is bottom, the order must be reversed
                const lines = dan.text.split('\n');
                for (const line of (dan.type === 'bottom') ? lines.reverse() : lines) {

                    const danmakuItem = document.createElement('div');
                    danmakuItem.classList.add('dplayer-danmaku-item');
                    danmakuItem.classList.add(`dplayer-danmaku-${dan.type}`); // set danmaku type (CSS)
                    danmakuItem.classList.add(`dplayer-danmaku-size-${dan.size}`); // set danmaku size (CSS)
                    danmakuItem.style.fontSize = `${itemFontSize}px`;

                    // set danmaku color
                    danmakuItem.style.color = dan.color;

                    // set danmaku text
                    if ('border' in dan && dan.border) {
                        const span = document.createElement('span');
                        span.style.border = `2px solid ${this.options.borderColor}`;
                        span.textContent = line;
                        danmakuItem.appendChild(span);
                    } else {
                        danmakuItem.textContent = line;
                    }

                    // ensure and adjust danmaku position
                    const animationDuration = this._danAnimation(dan.type);
                    const duration = parseFloat(animationDuration) * 1000;
                    const placement = getTunnel(danmakuItem, dan.type, itemWidth, duration);
                    switch (dan.type) {
                        case 'right':
                            if (placement !== null) {
                                danmakuItem.style.width = itemWidth + 1 + 'px';
                                danmakuItem.style.top = itemHeight * placement.lane + 8 + 'px';
                                danmakuItem.style.transform = `translate3d(${itemWidth + 1}px, 0, 0)`;
                                danmakuItem.style.willChange = 'transform';
                                startAnimations.push(() => {
                                    // Web Animations gives every rolling comment an independent compositor
                                    // timeline. Adding a new DOM node can no longer restart or retarget the
                                    // transforms of comments that are already moving.
                                    const animation = danmakuItem.animate(
                                        [
                                            { transform: `translate3d(${itemWidth + 1}px, 0, 0)` },
                                            { transform: `translate3d(-${danWidth}px, 0, 0)` },
                                        ],
                                        { duration, easing: 'linear', fill: 'forwards' },
                                    );
                                    placement.item.animation = animation;
                                    this.animations.add(animation);
                                    if (this.paused) animation.pause();
                                    animation.onfinish = () => {
                                        this.animations.delete(animation);
                                        removeTunnelItem(dan.type, placement);
                                    };
                                });
                            }
                            break;
                        case 'top':
                            if (placement !== null) {
                                danmakuItem.style.width = itemWidth + 1 + 'px';
                                danmakuItem.style.top = itemHeight * placement.lane + 8 + 'px';
                                danmakuItem.style.willChange = 'visibility';
                            }
                            break;
                        case 'bottom':
                            if (placement !== null) {
                                danmakuItem.style.width = itemWidth + 1 + 'px';
                                danmakuItem.style.bottom = itemHeight * placement.lane + 8 + 'px';
                                danmakuItem.style.willChange = 'visibility';
                            }
                            break;
                        default:
                            console.error(`Can't handled danmaku type: ${dan.type}`);
                    }

                    if (placement !== null) {
                        if (dan.type !== 'right') {
                            danmakuItem.classList.add('dplayer-danmaku-move');
                            danmakuItem.style.animationDuration = animationDuration;
                            danmakuItem.addEventListener('animationend', () => removeTunnelItem(dan.type, placement), { once: true });
                        }

                        // insert
                        docFragment.appendChild(danmakuItem);
                    }
                }
            }

            // draw danmaku
            this.container.appendChild(docFragment);
            startAnimations.forEach(start => start());
            return docFragment;
        }

        return null;
    }

    private initCanvas(): void {
        const createCanvas = (): HTMLCanvasElement => {
            const canvas = document.createElement('canvas');
            canvas.className = 'dplayer-danmaku-canvas';
            canvas.setAttribute('aria-hidden', 'true');
            return canvas;
        };

        this.canvas = createCanvas();
        if (this.options.renderMode === 'webgl-worker') {
            try {
                const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
                this.workerRenderer = new WebGLDanmakuWorkerRenderer(this.canvas, {
                    width: this.containerWidth,
                    height: this.containerHeight,
                    pixelRatio,
                    opacity: this._opacity,
                    debugMotion: this.options.debugMotion,
                    onExpired: ids => this.removeExpiredWorkerItems(ids),
                    onError: error => console.warn('[DPlayer] Danmaku Worker renderer failed.', error),
                });
            } catch (error) {
                console.warn('[DPlayer] Worker WebGL danmaku is unavailable; falling back to main-thread WebGL.', error);
                this.canvas = createCanvas();
                try {
                    this.webglRenderer = new WebGLDanmakuRenderer(this.canvas);
                } catch (webglError) {
                    console.warn('[DPlayer] WebGL danmaku is unavailable; falling back to Canvas.', webglError);
                    this.canvas = createCanvas();
                    this.canvasContext = this.canvas.getContext('2d', { alpha: true });
                }
            }
        } else if (this.options.renderMode === 'webgl' || this.options.renderMode === 'webgl-composite') {
            try {
                this.webglRenderer = new WebGLDanmakuRenderer(this.canvas);
            } catch (error) {
                console.warn('[DPlayer] WebGL danmaku is unavailable; falling back to Canvas.', error);
                this.canvas = createCanvas();
                this.canvasContext = this.canvas.getContext('2d', { alpha: true });
            }
        } else {
            this.canvasContext = this.canvas.getContext('2d', { alpha: true });
        }
        this.container.appendChild(this.canvas);
        this.resizeCanvas();
    }

    private resizeCanvas(): void {
        if (!this.canvas) return;
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        if (this.workerRenderer) {
            this.workerRenderer.resize(this.containerWidth, this.containerHeight, pixelRatio);
            return;
        }
        if (this.webglRenderer) {
            this.webglRenderer.resize(this.containerWidth, this.containerHeight, pixelRatio);
            return;
        }
        if (!this.canvasContext) return;
        const width = Math.max(1, Math.round(this.containerWidth * pixelRatio));
        const height = Math.max(1, Math.round(this.containerHeight * pixelRatio));
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        this.canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }

    private clearCanvas(): void {
        if (this.workerRenderer) {
            this.workerRenderer.clear();
            return;
        }
        if (this.webglRenderer) {
            this.webglRenderer.clear();
            return;
        }
        if (!this.canvasContext) return;
        this.canvasContext.clearRect(0, 0, this.containerWidth, this.containerHeight);
    }

    private drawCanvas(dan: DPlayerType.DanmakuItem | DPlayerType.DanmakuItem[] | DPlayerType.Dan[]): void {
        const danList = Array.isArray(dan) ? dan : [dan];
        const ratio = Math.min(1, this.containerWidth / 1024 * 1.25);
        const baseItemFontSize = this.options.fontSize * ratio;
        const itemHeight = baseItemFontSize + (6 * ratio);
        const laneCount = Math.max(1, Math.floor(this.containerHeight / itemHeight));
        const danWidth = this.containerWidth;
        const danHeight = this.containerHeight;

        const canShareRightLane = (previous: DanmakuTunnelItem, width: number, duration: number, now: number): boolean => {
            const elapsed = Math.max(0, previous.renderedElapsed ?? now - previous.startedAt);
            if (elapsed >= previous.duration) return true;
            const progress = elapsed / previous.duration;
            const previousRight = (danWidth + previous.width) * (1 - progress);
            const gap = danWidth - previousRight;
            const minimumGap = 10;
            if (gap < minimumGap) return false;
            const previousSpeed = (danWidth + previous.width) / previous.duration;
            const nextSpeed = (danWidth + width) / duration;
            if (nextSpeed <= previousSpeed) return true;
            const catchUpTime = (gap - minimumGap) / (nextSpeed - previousSpeed);
            return catchUpTime >= previous.duration - elapsed;
        };

        const getTunnel = (type: DPlayerType.DanmakuType, width: number, duration: number): DanmakuTunnelPlacement | null => {
            const now = performance.now();
            const tunnelItem: DanmakuTunnelItem = { element: null, width, startedAt: now, duration };
            for (let i = 0; this.unlimited || i < laneCount; i++) {
                const lane = this.danTunnel[type][i + ''];
                if (lane?.length) {
                    if (type !== 'right' || !canShareRightLane(lane[lane.length - 1], width, duration, now)) continue;
                    lane.push(tunnelItem);
                } else {
                    this.danTunnel[type][i + ''] = [tunnelItem];
                }
                return { lane: i, item: tunnelItem };
            }
            return null;
        };

        for (const source of danList) {
            const color = typeof source.color === 'number' && isFinite(source.color)
                ? utils.number2Color(source.color)
                : source.color || '#ffeaea';
            const convertedType = typeof source.type === 'number' && isFinite(source.type)
                ? utils.number2Type(source.type) as DPlayerType.DanmakuType
                : source.type;
            const type: DPlayerType.DanmakuType = convertedType === 'top' || convertedType === 'bottom' || convertedType === 'right'
                ? convertedType
                : 'right';
            const size = source.size || 'medium';
            const fontSize = baseItemFontSize * (size === 'big' ? 1.25 : size === 'small' ? 0.8 : 1);
            const lines = source.text.split('\n');
            const width = lines.reduce((maximum, line) => Math.max(maximum, this._measure(line, fontSize)), 0);
            const duration = parseFloat(this._danAnimation(type)) * 1000;
            const orderedLines = type === 'bottom' ? [...lines].reverse() : lines;

            for (const line of orderedLines) {
                const placement = getTunnel(type, width, duration);
                if (!placement) continue;
                const border = 'border' in source && Boolean(source.border);
                const bitmap = this.createCanvasDanmakuBitmap(line, color, fontSize, border);
                const webglSprite = this.webglRenderer?.createSprite(bitmap.canvas, bitmap.width, bitmap.height);
                const workerId = this.nextWorkerId++;
                const startX = type === 'right' ? danWidth : (danWidth - width) / 2;
                const endX = type === 'right' ? -width : startX;
                const y = type === 'bottom'
                    ? danHeight - itemHeight * (placement.lane + 1) - 8
                    : itemHeight * placement.lane + 8;
                const item: CanvasDanmakuItem = {
                    workerId,
                    type,
                    x: startX,
                    y,
                    startX,
                    endX,
                    bitmap: bitmap.canvas,
                    bitmapWidth: bitmap.width,
                    bitmapHeight: bitmap.height,
                    bitmapPadding: bitmap.padding,
                    webglSprite,
                    placement,
                };
                this.canvasItems.add(item);
                this.workerRenderer?.add({
                    id: workerId,
                    type,
                    startX,
                    endX,
                    y,
                    width: bitmap.width,
                    height: bitmap.height,
                    padding: bitmap.padding,
                    duration,
                    elapsed: Math.max(0, performance.now() - placement.item.startedAt),
                }, bitmap.canvas);
            }
        }
    }

    private renderCanvas(now: number): void {
        if (this.workerRenderer) return;
        const context = this.canvasContext;
        if (!context && !this.webglRenderer) return;
        if (this.webglRenderer) {
            this.webglRenderer.beginFrame(this._opacity);
            if (this.options.renderMode === 'webgl-composite' && !this.compositeFailed) this.renderCompositeVideo();
        }
        else {
            this.clearCanvas();
            context!.globalAlpha = this._opacity;
        }
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

        for (const item of [...this.canvasItems]) {
            const tunnelItem = item.placement.item;
            const targetElapsed = Math.max(0, now - tunnelItem.startedAt);
            const renderedElapsed = tunnelItem.renderedElapsed ?? 0;
            const frameElapsed = tunnelItem.lastRenderedAt === undefined
                ? Math.min(targetElapsed, 1000 / 60)
                : Math.max(0, now - tunnelItem.lastRenderedAt);
            // A throttled requestAnimationFrame used to jump straight to its absolute
            // timestamp. Advance at a bounded rate and recover the delay gradually so
            // another video or DWM stall cannot produce a large one-frame displacement.
            const baseAdvance = Math.min(frameElapsed, 1000 / 30);
            const delayed = Math.max(0, targetElapsed - renderedElapsed - baseAdvance);
            const catchUp = Math.min(delayed * 0.12, baseAdvance * 0.25);
            const elapsed = Math.min(targetElapsed, renderedElapsed + baseAdvance + catchUp);
            tunnelItem.renderedElapsed = elapsed;
            tunnelItem.lastRenderedAt = now;
            if (elapsed >= item.placement.item.duration) {
                this.removeCanvasItem(item);
                continue;
            }
            if (item.type === 'right') {
                const progress = elapsed / item.placement.item.duration;
                item.x = item.startX + (item.endX - item.startX) * progress;
            }
            // Cache glyph rasterization per comment. Snapping only the final bitmap
            // position to a device pixel prevents sub-pixel text re-rasterization from
            // looking like horizontal vibration while retaining smooth movement.
            const drawX = Math.round((item.x - item.bitmapPadding) * pixelRatio) / pixelRatio;
            const drawY = Math.round((item.y - item.bitmapPadding) * pixelRatio) / pixelRatio;
            const motionRegressed = item.type === 'right' && item.lastDrawX !== undefined && drawX > item.lastDrawX;
            item.lastDrawX = drawX;
            if (this.webglRenderer && item.webglSprite) {
                this.webglRenderer.drawSprite(item.webglSprite, drawX, drawY);
                if (this.options.debugMotion && item.type === 'right') {
                    this.webglRenderer.drawDebugMarker(
                        drawX,
                        drawY + item.bitmapPadding,
                        item.bitmapHeight - item.bitmapPadding * 2,
                        motionRegressed,
                    );
                }
            } else if (context) {
                context.drawImage(item.bitmap, drawX, drawY, item.bitmapWidth, item.bitmapHeight);
                if (this.options.debugMotion && item.type === 'right') {
                    context.fillStyle = motionRegressed ? '#ffc714' : '#ff2020';
                    context.fillRect(
                        drawX - 7,
                        drawY + item.bitmapPadding,
                        4,
                        Math.max(8, item.bitmapHeight - item.bitmapPadding * 2),
                    );
                }
            }
        }
        if (context) context.globalAlpha = 1;
    }

    private renderCompositeVideo(): void {
        if (!this.webglRenderer) return;
        const video = this.player.video;
        if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return;
        try {
            const scale = Math.min(this.containerWidth / video.videoWidth, this.containerHeight / video.videoHeight);
            const width = video.videoWidth * scale;
            const height = video.videoHeight * scale;
            const x = (this.containerWidth - width) / 2;
            const y = (this.containerHeight - height) / 2;
            this.webglRenderer.drawVideo(video, x, y, width, height);
            if (!this.compositeVideos.has(video)) {
                this.compositeVideos.add(video);
                video.style.opacity = '0';
            }
        } catch (error) {
            this.compositeFailed = true;
            this.restoreCompositeVideos();
            console.warn('[DPlayer] Video and danmaku WebGL composition failed; keeping the native video layer.', error);
        }
    }

    private restoreCompositeVideos(): void {
        for (const video of this.compositeVideos) video.style.removeProperty('opacity');
        this.compositeVideos.clear();
    }

    private createCanvasDanmakuBitmap(
        text: string,
        color: string,
        fontSize: number,
        border: boolean,
    ): { canvas: HTMLCanvasElement, width: number, height: number, padding: number } {
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const padding = Math.ceil(Math.max(4, fontSize * 0.1));
        const textWidth = this._measure(text, fontSize);
        const width = Math.max(1, Math.ceil(textWidth + padding * 2));
        const height = Math.max(1, Math.ceil(fontSize * 1.35 + padding * 2));
        const bitmap = document.createElement('canvas');
        bitmap.width = Math.ceil(width * pixelRatio);
        bitmap.height = Math.ceil(height * pixelRatio);
        const context = bitmap.getContext('2d', { alpha: true })!;
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.font = `bold ${fontSize}px "Segoe UI", Arial`;
        context.textBaseline = 'top';
        context.textAlign = 'left';
        context.lineJoin = 'round';
        context.lineWidth = Math.max(1.5, fontSize * 0.055);
        context.strokeStyle = 'rgba(0, 0, 0, 0.82)';
        context.strokeText(text, padding, padding);
        context.fillStyle = color;
        context.fillText(text, padding, padding);
        if (border) {
            context.lineWidth = 2;
            context.strokeStyle = this.options.borderColor;
            context.strokeRect(padding - 2, padding - 2, textWidth + 4, fontSize + 4);
        }
        return { canvas: bitmap, width, height, padding };
    }

    private removeCanvasItem(item: CanvasDanmakuItem): void {
        this.canvasItems.delete(item);
        this.workerRenderer?.remove(item.workerId);
        this.webglRenderer?.deleteSprite(item.webglSprite);
        const lane = this.danTunnel[item.type][item.placement.lane + ''];
        if (!lane) return;
        const index = lane.indexOf(item.placement.item);
        if (index >= 0) lane.splice(index, 1);
    }

    private removeExpiredWorkerItems(ids: number[]): void {
        const expired = new Set(ids);
        for (const item of [...this.canvasItems]) {
            if (expired.has(item.workerId)) this.removeCanvasItem(item);
        }
    }

    play(): void {
        this.workerRenderer?.play();
        if (this.usesSurfaceRenderer() && this.canvasPausedAt !== null) {
            const now = performance.now();
            const pausedDuration = now - this.canvasPausedAt;
            for (const item of this.canvasItems) {
                item.placement.item.startedAt += pausedDuration;
                item.placement.item.lastRenderedAt = now;
            }
            this.canvasPausedAt = null;
        }
        this.paused = false;
        this.animations.forEach(animation => animation.play());
    }

    pause(): void {
        this.paused = true;
        this.workerRenderer?.pause();
        if (this.usesSurfaceRenderer() && this.canvasPausedAt === null) {
            this.canvasPausedAt = performance.now();
        }
        this.animations.forEach(animation => animation.pause());
    }

    _measure(text: string, itemFontSize: number): number {
        let context = this.measureContexts.get(itemFontSize);
        if (!context) {
            context = document.createElement('canvas').getContext('2d')!;
            context.font = `bold ${itemFontSize}px "Segoe UI", Arial`;
            this.measureContexts.set(itemFontSize, context);
        }

        // returns the width of the widest line
        const lines = text.split('\n');
        let maxWidth = 0;
        for (let i = 0; i < lines.length; i++) {
            maxWidth = Math.max(maxWidth, context.measureText(lines[i]).width);
        }
        return maxWidth;
    }

    seek(): void {
        this.clear();
        for (let i = 0; i < this.dan.length; i++) {
            if (this.dan[i].time >= this.options.time()) {
                this.danIndex = i;
                break;
            }
            this.danIndex = this.dan.length;
        }
    }

    clear(): void {
        this.animations.forEach(animation => animation.cancel());
        this.animations.clear();
        this.danTunnel = {
            right: {},
            top: {},
            bottom: {},
        };
        this.danIndex = 0;
        if (this.usesSurfaceRenderer()) {
            for (const item of this.canvasItems) this.webglRenderer?.deleteSprite(item.webglSprite);
            this.canvasItems.clear();
            this.workerRenderer?.clear();
            this.canvasPausedAt = this.paused ? performance.now() : null;
            if (this.canvas && this.canvas.parentNode !== this.container) this.container.appendChild(this.canvas);
            this.clearCanvas();
        } else {
            this.options.container.innerHTML = '';
        }

        this.events && this.events.trigger('danmaku_clear');
    }

    resize(): void {
        // Do not retarget an animation that is already in flight. Rewriting its
        // translateX destination produces a visible horizontal jump. New comments
        // always capture the dimensions cached by ResizeObserver before draw().
        const width = this.container.clientWidth;
        if (width !== this.containerWidth) this.measureContexts.clear();
        this.containerWidth = width;
        this.containerHeight = this.container.clientHeight;
        if (this.usesSurfaceRenderer()) this.resizeCanvas();
    }

    hide(): void {
        this.showing = false;
        this.pause();
        this.clear();

        this.events && this.events.trigger('danmaku_hide');
    }

    show(): void {
        this.seek();
        this.showing = true;
        this.play();

        this.events && this.events.trigger('danmaku_show');
    }

    toggle(): void {
        if (this.showing) {
            this.hide();
        } else {
            this.show();
        }
    }

    unlimit(boolean: boolean): void {
        this.unlimited = boolean;
    }

    speed(rate: number): void {
        this.options.speedRate = rate;
    }

    private usesSurfaceRenderer(): boolean {
        return this.options.renderMode === 'canvas'
            || this.options.renderMode === 'webgl'
            || this.options.renderMode === 'webgl-worker'
            || this.options.renderMode === 'webgl-composite';
    }

    _danAnimation(position: DPlayerType.DanmakuType): string {
        const rate = this.options.speedRate;
        const isFullScreen =
            this.player.fullScreen.isFullScreen('browser') ||
            this.player.fullScreen.isFullScreen('web');
        const animations = {
            top: `${(isFullScreen ? 4.5 : 4) / rate}s`,
            right: `${(isFullScreen ? 5.5 : 5) / rate}s`,
            bottom: `${(isFullScreen ? 4.5 : 4) / rate}s`,
        };
        return animations[position];
    }
}

export default Danmaku;
