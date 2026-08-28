import DPlayer from './player';
import Events from './events';
import utils from './utils';
import defaultApiBackend from './api';
import * as DPlayerType from './types';
import WebGLDanmakuRenderer, { WebGLDanmakuSprite } from './webgl-danmaku-renderer';
import WebGLDanmakuWorkerRenderer from './webgl-danmaku-worker-renderer';

const DANMAKU_FRAME_INTERVAL = 1000 / 60;

interface DanmakuOptions {
    player: DPlayer,
    container: HTMLElement,
    opacity: number,
    callback: () => void,
    error: (msg: string) => void,
    apiBackend: DPlayerType.APIBackend,
    borderColor: string,
    fontSize: number,
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
    startedMediaTime: number | null,
    duration: number,
    renderedElapsed?: number,
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
    canvas: HTMLCanvasElement | null = null;
    canvasContext: CanvasRenderingContext2D | null = null;
    webglRenderer: WebGLDanmakuRenderer | null = null;
    workerRenderer: WebGLDanmakuWorkerRenderer | null = null;
    canvasItems = new Set<CanvasDanmakuItem>();
    canvasPausedAt: number | null = null;
    nextWorkerId = 1;
    mediaWaiting = false;
    nextCanvasRenderAt = 0;

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
        this.initCanvas();
        this.events.on('destroy', () => {
            this.workerRenderer?.destroy();
            this.workerRenderer = null;
        });
        this.events.on('waiting', () => {
            this.mediaWaiting = true;
            this.syncWorkerClock(true);
        });
        this.events.on('seeking', () => {
            this.mediaWaiting = true;
            this.syncWorkerClock(true);
        });
        this.events.on('playing', () => {
            this.mediaWaiting = false;
            this.syncWorkerClock(true);
        });
        this.events.on('canplay', () => {
            this.mediaWaiting = false;
            this.syncWorkerClock(true);
        });
        this.events.on('seeked', () => {
            this.mediaWaiting = false;
            this.syncWorkerClock(true);
        });
        this.events.on('ratechange', () => this.syncWorkerClock(true));
        this.events.on('ended', () => this.syncWorkerClock(true));
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
        this.renderCanvas(this.paused && this.canvasPausedAt !== null ? this.canvasPausedAt : performance.now());
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
        if (this.showing) this.drawCanvas(dan);
        return null;
    }

    private initCanvas(): void {
        this.canvas = this.createCanvas();
        try {
            this.workerRenderer = new WebGLDanmakuWorkerRenderer(this.canvas, {
                width: this.containerWidth,
                height: this.containerHeight,
                pixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
                opacity: this._opacity,
                onExpired: ids => this.removeExpiredWorkerItems(ids),
                onError: error => this.fallbackFromWorker(error),
            });
        } catch (error) {
            console.warn('[DPlayer] Worker WebGL danmaku is unavailable; falling back to main-thread rendering.', error);
            this.canvas = this.createCanvas();
            this.initMainThreadRenderer(this.canvas);
        }
        this.container.appendChild(this.canvas);
        this.resizeCanvas();
        this.syncWorkerClock(true);
    }

    private createCanvas(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.className = 'dplayer-danmaku-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        return canvas;
    }

    private initMainThreadRenderer(canvas: HTMLCanvasElement): void {
        try {
            this.webglRenderer = new WebGLDanmakuRenderer(canvas);
        } catch (error) {
            console.warn('[DPlayer] WebGL danmaku is unavailable; falling back to Canvas comments.', error);
            this.canvasContext = canvas.getContext('2d', { alpha: true });
        }
    }

    private fallbackFromWorker(error: Error): void {
        if (!this.workerRenderer || !this.canvas) return;
        console.warn('[DPlayer] Danmaku Worker failed; falling back to main-thread rendering.', error);
        this.workerRenderer.destroy();
        this.workerRenderer = null;
        const replacement = this.createCanvas();
        this.canvas.replaceWith(replacement);
        this.canvas = replacement;
        this.initMainThreadRenderer(replacement);
        for (const item of this.canvasItems) {
            item.webglSprite = this.webglRenderer?.createSprite(item.bitmap, item.bitmapWidth, item.bitmapHeight);
        }
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
            const tunnelItem: DanmakuTunnelItem = {
                element: null,
                width,
                startedAt: now,
                startedMediaTime: this.getMediaTimeMilliseconds(),
                duration,
            };
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
                const startedMediaTime = placement.item.startedMediaTime;
                const mediaTime = this.getMediaTimeMilliseconds();
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
                    startedMediaTime,
                    elapsed: mediaTime !== null && startedMediaTime !== null
                        ? Math.max(0, mediaTime - startedMediaTime)
                        : Math.max(0, performance.now() - placement.item.startedAt),
                }, bitmap.canvas);
            }
        }
    }

    private renderCanvas(now: number): void {
        if (this.workerRenderer) {
            this.syncWorkerClock();
            return;
        }
        if (this.canvasItems.size === 0) {
            this.nextCanvasRenderAt = 0;
            return;
        }
        const frameNow = performance.now();
        if (this.nextCanvasRenderAt !== 0 && frameNow < this.nextCanvasRenderAt) return;
        if (this.nextCanvasRenderAt === 0) this.nextCanvasRenderAt = frameNow + DANMAKU_FRAME_INTERVAL;
        else {
            do {
                this.nextCanvasRenderAt += DANMAKU_FRAME_INTERVAL;
            } while (this.nextCanvasRenderAt <= frameNow);
        }
        const context = this.canvasContext;
        if (!context && !this.webglRenderer) return;
        if (this.webglRenderer) {
            this.webglRenderer.beginFrame(this._opacity);
        }
        else {
            this.clearCanvas();
            context!.globalAlpha = this._opacity;
        }
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const mediaTime = this.getMediaTimeMilliseconds();

        for (const item of [...this.canvasItems]) {
            const tunnelItem = item.placement.item;
            const mediaElapsed = mediaTime !== null && tunnelItem.startedMediaTime !== null
                ? mediaTime - tunnelItem.startedMediaTime
                : null;
            if (mediaElapsed !== null && mediaElapsed < (tunnelItem.renderedElapsed ?? 0) - 250) {
                // A live reconnect or an unreported seek can reset the media clock.
                // Do not make an already-visible comment move backwards across the screen.
                this.removeCanvasItem(item);
                continue;
            }
            const elapsed = Math.max(
                tunnelItem.renderedElapsed ?? 0,
                mediaElapsed === null ? now - tunnelItem.startedAt : mediaElapsed,
            );
            tunnelItem.renderedElapsed = elapsed;
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
            if (this.webglRenderer && item.webglSprite) {
                this.webglRenderer.drawSprite(item.webglSprite, drawX, drawY);
            } else if (context) {
                context.drawImage(item.bitmap, drawX, drawY, item.bitmapWidth, item.bitmapHeight);
            }
        }
        if (context) context.globalAlpha = 1;
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
        if (this.canvasPausedAt !== null) {
            const now = performance.now();
            const pausedDuration = now - this.canvasPausedAt;
            for (const item of this.canvasItems) {
                item.placement.item.startedAt += pausedDuration;
            }
            this.canvasPausedAt = null;
        }
        this.paused = false;
        this.syncWorkerClock(true);
    }

    pause(): void {
        this.paused = true;
        if (this.canvasPausedAt === null) {
            this.canvasPausedAt = performance.now();
        }
        this.syncWorkerClock(true);
    }

    private getMediaTimeMilliseconds(): number | null {
        const time = this.options.time();
        return Number.isFinite(time) && time >= 0 ? time * 1000 : null;
    }

    private syncWorkerClock(force = false): void {
        const video = this.player.video;
        const playing = !this.paused
            && !this.mediaWaiting
            && !video.paused
            && !video.ended
            && !video.seeking
            && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        this.workerRenderer?.syncClock(this.getMediaTimeMilliseconds(), playing, video.playbackRate, force);
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
        this.danTunnel = {
            right: {},
            top: {},
            bottom: {},
        };
        this.danIndex = 0;
        for (const item of this.canvasItems) this.webglRenderer?.deleteSprite(item.webglSprite);
        this.canvasItems.clear();
        this.canvasPausedAt = this.paused ? performance.now() : null;
        if (this.canvas && this.canvas.parentNode !== this.container) this.container.appendChild(this.canvas);
        this.clearCanvas();

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
        this.resizeCanvas();
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
