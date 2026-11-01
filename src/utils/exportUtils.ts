/**
 * File download and high-resolution viewport snapshot utilities.
 */

export interface ViewportStampMetadata {
  specimenName: string;
  windSpeedMps: number;
  reynoldsNumber: number;
  meanCd: number;
  meanCl: number;
  dragForceN: number;
  liftForceN: number;
  mode: string;
}

/**
 * Triggers a native browser file download for a string or Blob.
 */
export function downloadFile(filename: string, content: string | Blob, mimeType = 'text/plain'): void {
  const blob = typeof content === 'string' ? new Blob([content], { type: mimeType }) : content;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Captures a Three.js / WebGPU canvas and composites a sleek engineering telemetry stamp
 * in the bottom-left corner before exporting as a high-resolution PNG.
 */
export async function captureViewportWithStamp(
  sourceCanvas: HTMLCanvasElement,
  metadata: ViewportStampMetadata
): Promise<Blob> {
  const offscreen = document.createElement('canvas');
  offscreen.width = sourceCanvas.width;
  offscreen.height = sourceCanvas.height;
  const ctx = offscreen.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create 2D canvas context for snapshot stamp.');
  }

  // Draw WebGPU/Three.js frame
  ctx.drawImage(sourceCanvas, 0, 0);

  // Responsive sizing based on viewport scale
  const scale = Math.max(1, offscreen.width / 1200);
  const padding = 16 * scale;
  const cardWidth = 380 * scale;
  const cardHeight = 110 * scale;
  const cardX = padding;
  const cardY = offscreen.height - cardHeight - padding;

  // Semi-transparent dark card background
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)'; // slate-900 with 88% opacity
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)'; // sky-400
  ctx.lineWidth = 2 * scale;
  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 8 * scale);
  ctx.fill();
  ctx.stroke();

  // Header Title
  ctx.fillStyle = '#38bdf8'; // sky-400
  ctx.font = `bold ${13 * scale}px "Inter", "Segoe UI", sans-serif`;
  ctx.fillText('AEROSIM 3D CFD WIND TUNNEL', cardX + 14 * scale, cardY + 22 * scale);

  // Model & Mode Subtitle
  ctx.fillStyle = '#f8fafc'; // slate-50
  ctx.font = `${11 * scale}px "Inter", "Segoe UI", sans-serif`;
  ctx.fillText(
    `${metadata.specimenName} · ${metadata.mode}`,
    cardX + 14 * scale,
    cardY + 40 * scale
  );

  // Metrics Line 1: Wind Speed & Re
  ctx.fillStyle = '#94a3b8'; // slate-400
  ctx.font = `${10 * scale}px "Inter", monospace`;
  ctx.fillText(
    `U∞: ${metadata.windSpeedMps.toFixed(1)} m/s · Re: ${metadata.reynoldsNumber.toLocaleString()}`,
    cardX + 14 * scale,
    cardY + 62 * scale
  );

  // Metrics Line 2: Cd and Drag Force
  ctx.fillStyle = '#fbbf24'; // amber-400
  ctx.font = `bold ${11 * scale}px "Inter", monospace`;
  ctx.fillText(
    `Cd: ${metadata.meanCd.toFixed(3)}  (Drag: ${metadata.dragForceN.toFixed(1)} N)`,
    cardX + 14 * scale,
    cardY + 82 * scale
  );

  // Metrics Line 3: Cl and Lift Force
  const liftSign = metadata.liftForceN >= 0 ? '+' : '';
  ctx.fillStyle = '#34d399'; // emerald-400
  ctx.fillText(
    `Cl: ${metadata.meanCl >= 0 ? '+' : ''}${metadata.meanCl.toFixed(3)}  (Lift: ${liftSign}${metadata.liftForceN.toFixed(1)} N)`,
    cardX + 14 * scale,
    cardY + 98 * scale
  );

  // Timestamp on the right
  ctx.fillStyle = '#64748b'; // slate-500
  ctx.font = `${9 * scale}px "Inter", monospace`;
  const timeStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  ctx.fillText(timeStr, cardX + cardWidth - 130 * scale, cardY + 22 * scale);

  ctx.restore();

  return new Promise((resolve, reject) => {
    offscreen.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Canvas toBlob conversion failed.'));
      }
    }, 'image/png');
  });
}
