export interface DisplayRefreshTiming {
    refreshRate: number;
    frameDivisor: number;
    frameInterval: number;
}
type DisplayRefreshTimingListener = (timing: DisplayRefreshTiming | null) => void;
export declare const subscribeDisplayRefreshTiming: (listener: DisplayRefreshTimingListener) => (() => void);
export declare const sampleDisplayRefreshFrame: (now: number) => void;
export {};
//# sourceMappingURL=display-refresh-rate.d.ts.map