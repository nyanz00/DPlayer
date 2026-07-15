import DPlayer from './player';
import Events from './events';
import utils from './utils';
import defaultApiBackend from './api';
import * as DPlayerType from './types';

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
}

interface CanvasDanmakuItem {
    text: string,
    color: string,
    type: DPlayerType.DanmakuType,
    fontSize: number,
    x: number,
    y: number,
    startX: number,
    endX: number,
    border: boolean,
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
    canvasItems = new Set<CanvasDanmakuItem>();
    canvasPausedAt: number | null = null;

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
        if (this.options.renderMode === 'canvas') this.initCanvas();
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
        if (this.options.renderMode === 'canvas') {
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
            if (this.options.renderMode === 'canvas') {
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
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'dplayer-danmaku-canvas';
        this.canvas.setAttribute('aria-hidden', 'true');
        this.canvasContext = this.canvas.getContext('2d', { alpha: true });
        this.container.appendChild(this.canvas);
        this.resizeCanvas();
    }

    private resizeCanvas(): void {
        if (!this.canvas || !this.canvasContext) return;
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const width = Math.max(1, Math.round(this.containerWidth * pixelRatio));
        const height = Math.max(1, Math.round(this.containerHeight * pixelRatio));
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        this.canvasContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    }

    private clearCanvas(): void {
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
            const elapsed = Math.max(0, now - previous.startedAt);
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
                const startX = type === 'right' ? danWidth : (danWidth - width) / 2;
                const endX = type === 'right' ? -width : startX;
                const y = type === 'bottom'
                    ? danHeight - itemHeight * (placement.lane + 1) - 8
                    : itemHeight * placement.lane + 8;
                this.canvasItems.add({
                    text: line,
                    color,
                    type,
                    fontSize,
                    x: startX,
                    y,
                    startX,
                    endX,
                    border: 'border' in source && Boolean(source.border),
                    placement,
                });
            }
        }
    }

    private renderCanvas(now: number): void {
        const context = this.canvasContext;
        if (!context) return;
        this.clearCanvas();
        context.globalAlpha = this._opacity;
        context.textBaseline = 'top';
        context.textAlign = 'left';
        context.lineJoin = 'round';

        for (const item of [...this.canvasItems]) {
            const elapsed = Math.max(0, now - item.placement.item.startedAt);
            if (elapsed >= item.placement.item.duration) {
                this.removeCanvasItem(item);
                continue;
            }
            if (item.type === 'right') {
                const progress = elapsed / item.placement.item.duration;
                item.x = item.startX + (item.endX - item.startX) * progress;
            }
            context.font = `bold ${item.fontSize}px "Segoe UI", Arial`;
            context.lineWidth = Math.max(1.5, item.fontSize * 0.055);
            context.strokeStyle = 'rgba(0, 0, 0, 0.82)';
            context.strokeText(item.text, item.x, item.y);
            context.fillStyle = item.color;
            context.fillText(item.text, item.x, item.y);
            if (item.border) {
                context.lineWidth = 2;
                context.strokeStyle = this.options.borderColor;
                const metrics = context.measureText(item.text);
                context.strokeRect(item.x - 2, item.y - 2, metrics.width + 4, item.fontSize + 4);
            }
        }
        context.globalAlpha = 1;
    }

    private removeCanvasItem(item: CanvasDanmakuItem): void {
        this.canvasItems.delete(item);
        const lane = this.danTunnel[item.type][item.placement.lane + ''];
        if (!lane) return;
        const index = lane.indexOf(item.placement.item);
        if (index >= 0) lane.splice(index, 1);
    }

    play(): void {
        if (this.options.renderMode === 'canvas' && this.canvasPausedAt !== null) {
            const pausedDuration = performance.now() - this.canvasPausedAt;
            for (const item of this.canvasItems) item.placement.item.startedAt += pausedDuration;
            this.canvasPausedAt = null;
        }
        this.paused = false;
        this.animations.forEach(animation => animation.play());
    }

    pause(): void {
        this.paused = true;
        if (this.options.renderMode === 'canvas' && this.canvasPausedAt === null) {
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
        if (this.options.renderMode === 'canvas') {
            this.canvasItems.clear();
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
        if (this.options.renderMode === 'canvas') this.resizeCanvas();
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
