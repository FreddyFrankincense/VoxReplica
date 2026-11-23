import React from 'react';

interface WaveformBarsProps {
  peaks: number[];
  accentColor?: string;
  height?: number;
  isPlaying?: boolean;
  progressRatio?: number;
}

export const WaveformBars: React.FC<WaveformBarsProps> = ({
  peaks,
  accentColor = '#F59E0B',
  height = 40,
  isPlaying = false,
  progressRatio = 0,
}) => {
  const safePeaks = peaks && peaks.length > 0 ? peaks : Array.from({ length: 48 }, (_, i) => 0.2 + 0.5 * Math.abs(Math.sin(i * 0.35)));

  return (
    <div
      className="w-full flex items-center gap-[2px] select-none overflow-hidden"
      style={{ height: `${height}px` }}
      aria-label="Audio waveform visualization"
    >
      {safePeaks.map((peak, idx) => {
        const ratio = idx / safePeaks.length;
        const isPlayed = isPlaying && ratio <= progressRatio;
        const barHeightPercent = Math.max(12, Math.min(100, Math.round(peak * 100)));

        return (
          <div
            key={idx}
            className="flex-1 rounded-xs transition-opacity duration-150"
            style={{
              height: `${barHeightPercent}%`,
              backgroundColor: isPlayed ? '#F8FAFC' : accentColor,
              opacity: isPlaying ? (isPlayed ? 0.95 : 0.45) : 0.8,
            }}
          />
        );
      })}
    </div>
  );
};
