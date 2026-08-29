import { WebGLDanmakuSprite } from './webgl-danmaku-renderer';

interface AtlasSegment {
    x: number,
    width: number,
}

interface AtlasRow {
    y: number,
    height: number,
    nextX: number,
    free: AtlasSegment[],
}

interface AtlasPage {
    texture: WebGLTexture,
    size: number,
    nextY: number,
    rows: AtlasRow[],
    allocations: number,
}

interface AtlasAllocation {
    page: AtlasPage,
    row: AtlasRow,
    x: number,
    y: number,
    width: number,
    height: number,
}

interface BatchSprite extends WebGLDanmakuSprite {
    allocation: AtlasAllocation,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
}

interface BatchInstance {
    sprite: BatchSprite,
    x: number,
    y: number,
    color: [number, number, number, number],
}

type WebGL2DanmakuCanvas = HTMLCanvasElement | OffscreenCanvas;

const DEFAULT_ATLAS_SIZE = 2048;
const MAX_ATLAS_SIZE = 4096;
const ATLAS_GUTTER = 1;
const INSTANCE_FLOATS = 12;

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
    private readonly vertexBuffer: WebGLBuffer;
    private readonly instanceBuffer: WebGLBuffer;
    private readonly pages: AtlasPage[] = [];
    private readonly instances: BatchInstance[] = [];
    private readonly defaultAtlasSize: number;
    private readonly maximumAtlasSize: number;
    private pixelRatio = 1;

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
        const maximumTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
        this.maximumAtlasSize = Math.min(MAX_ATLAS_SIZE, maximumTextureSize);
        this.defaultAtlasSize = Math.min(DEFAULT_ATLAS_SIZE, this.maximumAtlasSize);

        const vertexBuffer = gl.createBuffer();
        const instanceBuffer = gl.createBuffer();
        if (!vertexBuffer || !instanceBuffer) throw new Error('Unable to create WebGL2 danmaku buffers');
        this.vertexBuffer = vertexBuffer;
        this.instanceBuffer = instanceBuffer;

        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
        const stride = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 4 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribDivisor(2, 1);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 8 * Float32Array.BYTES_PER_ELEMENT);
        gl.vertexAttribDivisor(3, 1);

        gl.useProgram(this.program);
        const textureLocation = this.requireUniform('u_texture');
        gl.uniform1i(textureLocation, 0);
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
        gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            allocation.x + ATLAS_GUTTER,
            allocation.y + ATLAS_GUTTER,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            source,
        );
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

    deleteSprite(sprite: WebGLDanmakuSprite | undefined): void {
        if (!sprite || !('allocation' in sprite)) return;
        const batchSprite = sprite as BatchSprite;
        const { allocation } = batchSprite;
        const row = allocation.row;
        row.free.push({ x: allocation.x, width: allocation.width });
        row.free.sort((a, b) => a.x - b.x);
        const merged: AtlasSegment[] = [];
        for (const segment of row.free) {
            const previous = merged[merged.length - 1];
            if (previous && previous.x + previous.width >= segment.x) {
                previous.width = Math.max(previous.width, segment.x + segment.width - previous.x);
            } else {
                merged.push({ ...segment });
            }
        }
        row.free = merged;
        allocation.page.allocations--;
        if (allocation.page.allocations === 0 && this.pages.length > 1) {
            this.gl.deleteTexture(allocation.page.texture);
            const pageIndex = this.pages.indexOf(allocation.page);
            if (pageIndex >= 0) this.pages.splice(pageIndex, 1);
        }
    }

    beginFrame(opacity: number): void {
        this.instances.length = 0;
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.useProgram(this.program);
        this.gl.uniform1f(this.opacityLocation, opacity);
    }

    drawSprite(sprite: WebGLDanmakuSprite, x: number, y: number, color: [number, number, number, number] = [1, 1, 1, 1]): void {
        if (!('allocation' in sprite)) return;
        this.instances.push({ sprite: sprite as BatchSprite, x, y, color });
    }

    endFrame(): void {
        if (this.instances.length === 0) return;
        const gl = this.gl;
        const ratio = this.pixelRatio;
        const grouped = new Map<AtlasPage, BatchInstance[]>();
        for (const instance of this.instances) {
            const page = instance.sprite.allocation.page;
            const pageInstances = grouped.get(page);
            if (pageInstances) pageInstances.push(instance);
            else grouped.set(page, [instance]);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        for (const [page, pageInstances] of grouped) {
            const data = new Float32Array(pageInstances.length * INSTANCE_FLOATS);
            let offset = 0;
            for (const instance of pageInstances) {
                const { sprite, color } = instance;
                data[offset++] = instance.x * ratio;
                data[offset++] = instance.y * ratio;
                data[offset++] = sprite.width * ratio;
                data[offset++] = sprite.height * ratio;
                data[offset++] = sprite.u0;
                data[offset++] = sprite.v0;
                data[offset++] = sprite.u1;
                data[offset++] = sprite.v1;
                data[offset++] = color[0];
                data[offset++] = color[1];
                data[offset++] = color[2];
                data[offset++] = color[3];
            }
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, page.texture);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, pageInstances.length);
        }
    }

    clear(): void {
        this.instances.length = 0;
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
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
        if (!texture) throw new Error('Unable to create WebGL2 danmaku atlas');
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const page: AtlasPage = { texture, size, nextY: 0, rows: [], allocations: 0 };
        this.pages.push(page);
        return page;
    }

    private createProgram(): WebGLProgram {
        const vertex = this.compileShader(this.gl.VERTEX_SHADER, `#version 300 es
            layout(location = 0) in vec2 a_position;
            layout(location = 1) in vec4 a_rectangle;
            layout(location = 2) in vec4 a_texture_rectangle;
            layout(location = 3) in vec4 a_color;
            uniform vec2 u_resolution;
            out vec2 v_texcoord;
            out vec4 v_color;
            void main() {
                vec2 pixel = a_rectangle.xy + a_position * a_rectangle.zw;
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
                out_color = vec4(
                    sampled.rgb * v_color.rgb * u_opacity,
                    sampled.a * v_color.a * u_opacity
                );
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
