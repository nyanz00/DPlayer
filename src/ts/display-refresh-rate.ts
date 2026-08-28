export interface DisplayRefreshTiming {
    refreshRate: number,
    frameDivisor: number,
    frameInterval: number,
}

type DisplayRefreshTimingListener = (timing: DisplayRefreshTiming | null) => void;

interface CachedDisplayRefreshTiming extends DisplayRefreshTiming {
    measuredAt: number,
    screenSignature: string,
}

const CACHE_KEY = 'dplayer-danmaku-display-refresh-v1';
const CACHE_MAX_AGE = 12 * 60 * 60 * 1000;
const SAMPLE_COUNT = 60;
const MIN_INTERVAL = 1000 / 360;
const MAX_INTERVAL = 1000 / 24;
const DIVERGENCE_RATIO = 0.2;
const DIVERGENCE_SAMPLE_COUNT = 8;

const getScreenSignature = (): string => {
    const screenInfo = window.screen;
    return [
        screenInfo?.width ?? 0,
        screenInfo?.height ?? 0,
        screenInfo?.availWidth ?? 0,
        screenInfo?.availHeight ?? 0,
        window.devicePixelRatio || 1,
    ].join('x');
};

const loadCachedTiming = (): CachedDisplayRefreshTiming | null => {
    try {
        const raw = window.sessionStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const cached = JSON.parse(raw) as Partial<CachedDisplayRefreshTiming>;
        if (!Number.isFinite(cached.refreshRate)
            || !Number.isInteger(cached.frameDivisor)
            || !Number.isFinite(cached.frameInterval)
            || !Number.isFinite(cached.measuredAt)
            || cached.screenSignature !== getScreenSignature()
            || Date.now() - cached.measuredAt! > CACHE_MAX_AGE) return null;
        if (cached.refreshRate! < 24
            || cached.refreshRate! > 360
            || cached.frameDivisor! < 1
            || cached.frameDivisor! > 8
            || cached.frameInterval! <= 0) return null;
        return cached as CachedDisplayRefreshTiming;
    } catch {
        return null;
    }
};

class DisplayRefreshRateMonitor {
    private readonly listeners = new Set<DisplayRefreshTimingListener>();
    private timing: CachedDisplayRefreshTiming | null = typeof window === 'undefined' ? null : loadCachedTiming();
    private lastFrameAt: number | null = null;
    private samples: number[] = [];
    private divergentSamples = 0;
    private screenSignature = typeof window === 'undefined' ? '' : getScreenSignature();

    private readonly visibilityChanged = (): void => {
        this.lastFrameAt = null;
        this.samples = [];
        this.divergentSamples = 0;
    };

    private readonly windowResized = (): void => {
        const signature = getScreenSignature();
        if (signature === this.screenSignature) return;
        this.screenSignature = signature;
        this.invalidate();
    };

    subscribe(listener: DisplayRefreshTimingListener): () => void {
        this.listeners.add(listener);
        listener(this.timing);
        if (this.listeners.size === 1) this.start();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) this.stop();
        };
    }

    private start(): void {
        window.addEventListener('resize', this.windowResized);
        document.addEventListener('visibilitychange', this.visibilityChanged);
    }

    private stop(): void {
        window.removeEventListener('resize', this.windowResized);
        document.removeEventListener('visibilitychange', this.visibilityChanged);
        this.lastFrameAt = null;
        this.samples = [];
        this.divergentSamples = 0;
    }

    sample(now: number): void {
        if (this.listeners.size === 0 || document.visibilityState !== 'visible' || !Number.isFinite(now)) return;
        if (this.lastFrameAt !== null && now > this.lastFrameAt) {
            const interval = now - this.lastFrameAt;
            if (interval >= MIN_INTERVAL) {
                this.addSample(interval);
                this.lastFrameAt = now;
            }
        } else if (this.lastFrameAt === null) {
            this.lastFrameAt = now;
        }
    }

    private addSample(interval: number): void {
        if (!Number.isFinite(interval) || interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
            this.samples = [];
            return;
        }
        if (this.timing) {
            const expectedInterval = this.timing.frameInterval / this.timing.frameDivisor;
            if (Math.abs(interval - expectedInterval) / expectedInterval > DIVERGENCE_RATIO) {
                this.divergentSamples++;
                if (this.divergentSamples >= DIVERGENCE_SAMPLE_COUNT) this.invalidate();
            } else {
                this.divergentSamples = 0;
            }
        }
        this.samples.push(interval);
        if (this.samples.length >= SAMPLE_COUNT) this.finishMeasurement();
    }

    private finishMeasurement(): void {
        const sorted = this.samples.slice(-SAMPLE_COUNT).sort((a, b) => a - b);
        this.samples = [];
        const medianInterval = sorted[Math.floor(sorted.length / 2)];
        const refreshRate = 1000 / medianInterval;
        if (!Number.isFinite(refreshRate) || refreshRate < 24 || refreshRate > 360) return;
        const frameDivisor = Math.max(1, Math.min(8, Math.round(refreshRate / 60)));
        const timing: CachedDisplayRefreshTiming = {
            refreshRate,
            frameDivisor,
            frameInterval: medianInterval * frameDivisor,
            measuredAt: Date.now(),
            screenSignature: getScreenSignature(),
        };
        const changed = this.timing === null
            || this.timing.frameDivisor !== timing.frameDivisor
            || Math.abs(this.timing.frameInterval - timing.frameInterval) > 0.5;
        this.divergentSamples = 0;
        if (!changed) return;
        this.timing = timing;
        this.screenSignature = timing.screenSignature;
        try {
            window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(timing));
        } catch {
            // Storage can be unavailable in private or embedded browsing contexts.
        }
        if (changed) this.notify();
    }

    private invalidate(): void {
        if (this.timing === null) return;
        this.timing = null;
        this.samples = [];
        this.lastFrameAt = null;
        this.divergentSamples = 0;
        try {
            window.sessionStorage.removeItem(CACHE_KEY);
        } catch {
            // Storage can be unavailable in private or embedded browsing contexts.
        }
        this.notify();
    }

    private notify(): void {
        for (const listener of this.listeners) listener(this.timing);
    }
}

const displayRefreshRateMonitor = new DisplayRefreshRateMonitor();

export const subscribeDisplayRefreshTiming = (listener: DisplayRefreshTimingListener): (() => void) => displayRefreshRateMonitor.subscribe(listener);
export const sampleDisplayRefreshFrame = (now: number): void => displayRefreshRateMonitor.sample(now);
