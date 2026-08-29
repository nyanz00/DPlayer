import { WebGLDanmakuSprite } from './webgl-danmaku-renderer';

interface AtlasSegment { x: number, width: number }
interface AtlasRow { y: number, height: number, nextX: number, free: AtlasSegment[] }
interface AtlasPage {
    texture: WebGLTexture,
    instanceBuffer: WebGLBuffer,
    size: number,
    nextY: number,
    rows: AtlasRow[],
    allocations: number,
    instances: Map<number, BatchInstance>,
    instancesDirty: boolean,
}
interface AtlasAllocation { page: AtlasPage, row: AtlasRow, x: number, y: number, width: number, height: number }
interface BatchSprite extends WebGLDanmakuSprite {
    allocation: AtlasAllocation,
    instanceId?: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
}
interface BatchInstance {
    sprite: BatchSprite,
    startX: number,
    endX: number,
    y: number,
    padding: number,
    duration: number,
    startedAt: number,
}
interface TimerQueryExtension { TIME_ELAPSED_EXT: number, GPU_DISJOINT_EXT: number }

export interface WebGL2BatchMotion {
    id: number,
    startX: number,
    endX: number,
    y: number,
    padding: number,
    duration: number,
    startedAt: number,
}
export interface WebGL2BatchFrameStats { drawCalls: number, gpuTimeMs: number | null }

type WebGL2DanmakuCanvas = HTMLCanvasElement | OffscreenCanvas;
const DEFAULT_ATLAS_SIZE = 2048;
const MAX_ATLAS_SIZE = 4096;
const ATLAS_GUTTER = 1;
const INSTANCE_FLOATS = 16;
const GPU_QUERY_INTERVAL = 120;
const nextPowerOfTwo = (value: number): number => {
    let result = 1;
    while (result < value) result *= 2;
    return result;
};

export default class WebGL2DanmakuBatchRenderer {
    private readonly gl: WebGL2RenderingContext;
    private readonly program: WebGLProgram;
    private readonly resolutionLocation: WebGLUniformLocation;
    private readonly opacityLocation: WebGLUniformLocation;
    private readonly clockLocation: WebGLUniformLocation;
    private readonly pages: AtlasPage[] = [];
    private readonly defaultAtlasSize: number;
    private readonly maximumAtlasSize: number;
    private readonly timerQueryExtension: TimerQueryExtension | null;
    private pixelRatio = 1;
    private activeTimerQuery: WebGLQuery | null = null;
    private pendingTimerQuery: WebGLQuery | null = null;
    private framesUntilTimerQuery = 0;
    private latestGpuTimeMs: number | null = null;
    private latestDrawCalls = 0;

    constructor(private readonly canvas: WebGL2DanmakuCanvas) {
        const gl = canvas.getContext('webgl2', {
            alpha: true,
            antialias: false,
            depth: false,
            desynchronized: true,
            powerPreference: 'high-performance',
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
            stencil: false,
        });
        if (!gl) throw new Error('WebGL2 is not available');
        this.gl = gl;
        this.program = this.createProgram();
        this.resolutionLocation = this.requireUniform('u_resolution');
        this.opacityLocation = this.requireUniform('u_opacity');
        this.clockLocation = this.requireUniform('u_clock');
        this.timerQueryExtension = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null;
        const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        this.maximumAtlasSize = Math.min(MAX_ATLAS_SIZE, maximumTextureSize);
        this.defaultAtlasSize = Math.min(DEFAULT_ATLAS_SIZE, this.maximumAtlasSize);

        const vertexBuffer = gl.createBuffer();
        if (!vertexBuffer) throw new Error('Unable to create WebGL2 danmaku vertex buffer');
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        gl.useProgram(this.program);
        gl.uniform1i(this.requireUniform('u_texture'), 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
    }

    resize(width: number, height: number, pixelRatio: number): void {
        this.pixelRatio = pixelRatio;
        const physicalWidth = Math.max(1, Math.round(width * pixelRatio));
        const physicalHeight = Math.max(1, Math.round(height * pixelRatio));
        if (this.canvas.width !== physicalWidth) this.canvas.width = physicalWidth;
        if (this.canvas.height !== physicalHeight) this.canvas.height = physicalHeight;
        this.gl.viewport(0, 0, physicalWidth, physicalHeight);
        this.gl.useProgram(this.program);
        this.gl.uniform2f(this.resolutionLocation, physicalWidth, physicalHeight);
        for (const page of this.pages) page.instancesDirty = true;
    }

    createSprite(source: TexImageSource, width: number, height: number): WebGLDanmakuSprite {
        const sourceSize = source as TexImageSource & { width: number, height: number };
        const sourceWidth = sourceSize.width;
        const sourceHeight = sourceSize.height;
        if (sourceWidth <= 0 || sourceHeight <= 0) throw new Error('Danmaku bitmap is empty');
        const allocation = this.allocate(sourceWidth + ATLAS_GUTTER * 2, sourceHeight + ATLAS_GUTTER * 2);
        const gl = this.gl;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, allocation.page.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, allocation.x + ATLAS_GUTTER, allocation.y + ATLAS_GUTTER, gl.RGBA, gl.UNSIGNED_BYTE, source);
        const size = allocation.page.size;
        return {
            texture: allocation.page.texture,
            width,
            height,
            allocation,
            u0: (allocation.x + ATLAS_GUTTER) / size,
            v0: (allocation.y + ATLAS_GUTTER) / size,
            u1: (allocation.x + ATLAS_GUTTER + sourceWidth) / size,
            v1: (allocation.y + ATLAS_GUTTER + sourceHeight) / size,
        } as BatchSprite;
    }

    registerSprite(sprite: WebGLDanmakuSprite, motion: WebGL2BatchMotion): void {
        if (!('allocation' in sprite)) return;
        const batchSprite = sprite as BatchSprite;
        batchSprite.instanceId = motion.id;
        const page = batchSprite.allocation.page;
        page.instances.set(motion.id, { sprite: batchSprite, ...motion });
        page.instancesDirty = true;
    }

    deleteSprite(sprite: WebGLDanmakuSprite | undefined): void {
        if (!sprite || !('allocation' in sprite)) return;
        const batchSprite = sprite as BatchSprite;
        const { allocation } = batchSprite;
        if (batchSprite.instanceId !== undefined) {
            allocation.page.instances.delete(batchSprite.instanceId);
            allocation.page.instancesDirty = true;
        }
        const row = allocation.row;
        row.free.push({ x: allocation.x, width: allocation.width });
        row.free.sort((a, b) => a.x - b.x);
        const merged: AtlasSegment[] = [];
        for (const segment of row.free) {
            const previous = merged[merged.length - 1];
            if (previous && previous.x + previous.width >= segment.x) previous.width = Math.max(previous.width, segment.x + segment.width - previous.x);
            else merged.push({ ...segment });
        }
        row.free = merged;
        allocation.page.allocations--;
        if (allocation.page.allocations === 0 && this.pages.length > 1) {
            this.gl.deleteBuffer(allocation.page.instanceBuffer);
            this.gl.deleteTexture(allocation.page.texture);
            const pageIndex = this.pages.indexOf(allocation.page);
            if (pageIndex >= 0) this.pages.splice(pageIndex, 1);
        }
    }

    beginFrame(opacity: number, clock = 0): void {
        this.pollTimerQuery();
        this.beginTimerQuery();
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.useProgram(this.program);
        this.gl.uniform1f(this.opacityLocation, opacity);
        this.gl.uniform1f(this.clockLocation, clock);
    }

    drawSprite(): void {
        // Instances are registered once and animated in the vertex shader.
    }

    endFrame(): void {
        const gl = this.gl;
        let drawCalls = 0;
        for (const page of this.pages) {
            if (page.instances.size === 0) continue;
            if (page.instancesDirty) this.rebuildInstanceBuffer(page);
            this.bindInstanceBuffer(page.instanceBuffer);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, page.texture);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, page.instances.size);
            drawCalls++;
        }
        this.latestDrawCalls = drawCalls;
        this.endTimerQuery();
    }

    clear(): void {
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    getFrameStats(): WebGL2BatchFrameStats {
        return { drawCalls: this.latestDrawCalls, gpuTimeMs: this.latestGpuTimeMs };
    }

    private rebuildInstanceBuffer(page: AtlasPage): void {
        const ratio = this.pixelRatio;
        const data = new Float32Array(page.instances.size * INSTANCE_FLOATS);
        let offset = 0;
        for (const instance of page.instances.values()) {
            const sprite = instance.sprite;
            data[offset++] = (instance.startX - instance.padding) * ratio;
            data[offset++] = (instance.endX - instance.padding) * ratio;
            data[offset++] = (instance.y - instance.padding) * ratio;
            data[offset++] = instance.startedAt;
            data[offset++] = sprite.width * ratio;
            data[offset++] = sprite.height * ratio;
            data[offset++] = instance.duration;
            data[offset++] = 0;
            data[offset++] = sprite.u0;
            data[offset++] = sprite.v0;
            data[offset++] = sprite.u1;
            data[offset++] = sprite.v1;
            data[offset++] = 1;
            data[offset++] = 1;
            data[offset++] = 1;
            data[offset++] = 1;
        }
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, page.instanceBuffer);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.STATIC_DRAW);
        page.instancesDirty = false;
    }

    private bindInstanceBuffer(buffer: WebGLBuffer): void {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        const stride = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
        for (let index = 0; index < 4; index++) {
            const location = index + 1;
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 4, gl.FLOAT, false, stride, index * 4 * Float32Array.BYTES_PER_ELEMENT);
            gl.vertexAttribDivisor(location, 1);
        }
    }

    private pollTimerQuery(): void {
        if (!this.timerQueryExtension || !this.pendingTimerQuery) return;
        const gl = this.gl;
        if (!(gl.getQueryParameter(this.pendingTimerQuery, gl.QUERY_RESULT_AVAILABLE) as boolean)) return;
        const disjoint = gl.getParameter(this.timerQueryExtension.GPU_DISJOINT_EXT) as boolean;
        if (!disjoint) {
            const nanoseconds = gl.getQueryParameter(this.pendingTimerQuery, gl.QUERY_RESULT) as number;
            if (Number.isFinite(nanoseconds)) this.latestGpuTimeMs = nanoseconds / 1_000_000;
        }
        gl.deleteQuery(this.pendingTimerQuery);
        this.pendingTimerQuery = null;
    }

    private beginTimerQuery(): void {
        if (!this.timerQueryExtension || this.pendingTimerQuery || this.activeTimerQuery) return;
        if (this.framesUntilTimerQuery > 0) {
            this.framesUntilTimerQuery--;
            return;
        }
        const query = this.gl.createQuery();
        if (!query) return;
        this.gl.beginQuery(this.timerQueryExtension.TIME_ELAPSED_EXT, query);
        this.activeTimerQuery = query;
    }

    private endTimerQuery(): void {
        if (!this.timerQueryExtension || !this.activeTimerQuery) return;
        this.gl.endQuery(this.timerQueryExtension.TIME_ELAPSED_EXT);
        this.pendingTimerQuery = this.activeTimerQuery;
        this.activeTimerQuery = null;
        this.framesUntilTimerQuery = GPU_QUERY_INTERVAL;
    }

    private allocate(width: number, height: number): AtlasAllocation {
        if (width > this.maximumAtlasSize || height > this.maximumAtlasSize) {
            throw new Error(`Danmaku bitmap ${width}x${height} exceeds WebGL2 texture limit ${this.maximumAtlasSize}`);
        }
        const rowHeight = nextPowerOfTwo(height);
        for (const page of this.pages) {
            if (page.size < width || page.size < rowHeight) continue;
            const allocation = this.allocateFromPage(page, width, height, rowHeight);
            if (allocation) return allocation;
        }
        const requiredSize = nextPowerOfTwo(Math.max(width, rowHeight));
        const page = this.createPage(Math.max(this.defaultAtlasSize, requiredSize));
        const allocation = this.allocateFromPage(page, width, height, rowHeight);
        if (!allocation) throw new Error('Unable to allocate danmaku texture atlas');
        return allocation;
    }

    private allocateFromPage(page: AtlasPage, width: number, height: number, rowHeight: number): AtlasAllocation | null {
        for (const row of page.rows) {
            if (row.height !== rowHeight) continue;
            const freeIndex = row.free.findIndex(segment => segment.width >= width);
            if (freeIndex >= 0) {
                const segment = row.free[freeIndex];
                const x = segment.x;
                if (segment.width === width) row.free.splice(freeIndex, 1);
                else {
                    segment.x += width;
                    segment.width -= width;
                }
                page.allocations++;
                return { page, row, x, y: row.y, width, height };
            }
            if (row.nextX + width <= page.size) {
                const x = row.nextX;
                row.nextX += width;
                page.allocations++;
                return { page, row, x, y: row.y, width, height };
            }
        }
        if (page.nextY + rowHeight > page.size) return null;
        const row: AtlasRow = { y: page.nextY, height: rowHeight, nextX: width, free: [] };
        page.nextY += rowHeight;
        page.rows.push(row);
        page.allocations++;
        return { page, row, x: 0, y: row.y, width, height };
    }

    private createPage(size: number): AtlasPage {
        const gl = this.gl;
        const texture = gl.createTexture();
        const instanceBuffer = gl.createBuffer();
        if (!texture || !instanceBuffer) throw new Error('Unable to create WebGL2 danmaku atlas');
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const page: AtlasPage = { texture, instanceBuffer, size, nextY: 0, rows: [], allocations: 0, instances: new Map(), instancesDirty: true };
        this.pages.push(page);
        return page;
    }

    private createProgram(): WebGLProgram {
        const vertex = this.compileShader(this.gl.VERTEX_SHADER, `#version 300 es
            layout(location = 0) in vec2 a_position;
            layout(location = 1) in vec4 a_motion;
            layout(location = 2) in vec4 a_geometry;
            layout(location = 3) in vec4 a_texture_rectangle;
            layout(location = 4) in vec4 a_color;
            uniform vec2 u_resolution;
            uniform float u_clock;
            out vec2 v_texcoord;
            out vec4 v_color;
            void main() {
                float progress = clamp((u_clock - a_motion.w) / a_geometry.z, 0.0, 1.0);
                float x = floor(mix(a_motion.x, a_motion.y, progress) + 0.5);
                vec2 pixel = vec2(x, a_motion.z) + a_position * a_geometry.xy;
                vec2 clip = pixel / u_resolution * 2.0 - 1.0;
                gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
                v_texcoord = mix(a_texture_rectangle.xy, a_texture_rectangle.zw, a_position);
                v_color = a_color;
            }
        `);
        const fragment = this.compileShader(this.gl.FRAGMENT_SHADER, `#version 300 es
            precision mediump float;
            uniform sampler2D u_texture;
            uniform float u_opacity;
            in vec2 v_texcoord;
            in vec4 v_color;
            out vec4 out_color;
            void main() {
                vec4 sampled = texture(u_texture, v_texcoord);
                out_color = vec4(sampled.rgb * v_color.rgb * u_opacity, sampled.a * v_color.a * u_opacity);
            }
        `);
        const program = this.gl.createProgram();
        if (!program) throw new Error('Unable to create WebGL2 danmaku program');
        this.gl.attachShader(program, vertex);
        this.gl.attachShader(program, fragment);
        this.gl.linkProgram(program);
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) throw new Error(this.gl.getProgramInfoLog(program) || 'Unable to link WebGL2 danmaku program');
        return program;
    }

    private compileShader(type: number, source: string): WebGLShader {
        const shader = this.gl.createShader(type);
        if (!shader) throw new Error('Unable to create WebGL2 danmaku shader');
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) throw new Error(this.gl.getShaderInfoLog(shader) || 'Unable to compile WebGL2 danmaku shader');
        return shader;
    }

    private requireUniform(name: string): WebGLUniformLocation {
        const location = this.gl.getUniformLocation(this.program, name);
        if (!location) throw new Error(`Missing WebGL2 uniform: ${name}`);
        return location;
    }
}
