export interface WebGLDanmakuSprite {
    texture: WebGLTexture,
    width: number,
    height: number,
}

export default class WebGLDanmakuRenderer {
    private readonly gl: WebGLRenderingContext;
    private readonly program: WebGLProgram;
    private readonly positionLocation: number;
    private readonly resolutionLocation: WebGLUniformLocation;
    private readonly rectangleLocation: WebGLUniformLocation;
    private readonly colorLocation: WebGLUniformLocation;
    private readonly opacityLocation: WebGLUniformLocation;
    private videoSprite: WebGLDanmakuSprite | null = null;
    private pixelRatio = 1;
    private frameOpacity = 1;

    constructor(private readonly canvas: HTMLCanvasElement) {
        const gl = canvas.getContext('webgl', {
            alpha: true,
            antialias: false,
            depth: false,
            premultipliedAlpha: true,
            preserveDrawingBuffer: false,
            stencil: false,
        });
        if (!gl) throw new Error('WebGL is not available');
        this.gl = gl;
        this.program = this.createProgram();
        this.positionLocation = gl.getAttribLocation(this.program, 'a_position');
        this.resolutionLocation = this.requireUniform('u_resolution');
        this.rectangleLocation = this.requireUniform('u_rectangle');
        this.colorLocation = this.requireUniform('u_color');
        this.opacityLocation = this.requireUniform('u_opacity');

        const buffer = gl.createBuffer();
        if (!buffer) throw new Error('Unable to create WebGL buffer');
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
        gl.useProgram(this.program);
        gl.enableVertexAttribArray(this.positionLocation);
        gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
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
        const texture = this.gl.createTexture();
        if (!texture) throw new Error('Unable to create WebGL texture');
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, source);
        return { texture, width, height };
    }

    deleteSprite(sprite: WebGLDanmakuSprite | undefined): void {
        if (sprite) this.gl.deleteTexture(sprite.texture);
    }

    beginFrame(opacity: number): void {
        this.frameOpacity = opacity;
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
        this.gl.useProgram(this.program);
        this.gl.uniform1f(this.opacityLocation, opacity);
    }

    drawVideo(video: HTMLVideoElement, x: number, y: number, width: number, height: number): void {
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) return;
        if (!this.videoSprite) {
            const texture = this.gl.createTexture();
            if (!texture) throw new Error('Unable to create video texture');
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
            this.videoSprite = { texture, width, height };
        }
        this.videoSprite.width = width;
        this.videoSprite.height = height;
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.videoSprite.texture);
        this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, video);
        this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
        this.gl.uniform1f(this.opacityLocation, 1);
        this.drawSprite(this.videoSprite, x, y);
        this.gl.uniform1f(this.opacityLocation, this.frameOpacity);
    }

    drawSprite(sprite: WebGLDanmakuSprite, x: number, y: number, color: [number, number, number, number] = [1, 1, 1, 1]): void {
        const ratio = this.pixelRatio;
        this.gl.bindTexture(this.gl.TEXTURE_2D, sprite.texture);
        this.gl.uniform4f(this.rectangleLocation, x * ratio, y * ratio, sprite.width * ratio, sprite.height * ratio);
        this.gl.uniform4f(this.colorLocation, color[0], color[1], color[2], color[3]);
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    }

    clear(): void {
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    private createProgram(): WebGLProgram {
        const vertex = this.compileShader(this.gl.VERTEX_SHADER, `
            attribute vec2 a_position;
            uniform vec2 u_resolution;
            uniform vec4 u_rectangle;
            varying vec2 v_texcoord;
            void main() {
                vec2 pixel = u_rectangle.xy + a_position * u_rectangle.zw;
                vec2 clip = pixel / u_resolution * 2.0 - 1.0;
                gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
                v_texcoord = a_position;
            }
        `);
        const fragment = this.compileShader(this.gl.FRAGMENT_SHADER, `
            precision mediump float;
            uniform sampler2D u_texture;
            uniform vec4 u_color;
            uniform float u_opacity;
            varying vec2 v_texcoord;
            void main() {
                vec4 sampled = texture2D(u_texture, v_texcoord);
                gl_FragColor = vec4(
                    sampled.rgb * u_color.rgb * u_opacity,
                    sampled.a * u_color.a * u_opacity
                );
            }
        `);
        const program = this.gl.createProgram();
        if (!program) throw new Error('Unable to create WebGL program');
        this.gl.attachShader(program, vertex);
        this.gl.attachShader(program, fragment);
        this.gl.linkProgram(program);
        if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) throw new Error(this.gl.getProgramInfoLog(program) || 'Unable to link WebGL program');
        return program;
    }

    private compileShader(type: number, source: string): WebGLShader {
        const shader = this.gl.createShader(type);
        if (!shader) throw new Error('Unable to create WebGL shader');
        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);
        if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) throw new Error(this.gl.getShaderInfoLog(shader) || 'Unable to compile WebGL shader');
        return shader;
    }

    private requireUniform(name: string): WebGLUniformLocation {
        const location = this.gl.getUniformLocation(this.program, name);
        if (!location) throw new Error(`Missing WebGL uniform: ${name}`);
        return location;
    }
}
