/**
 * B7 — barcode capture. Plan v02 §2/§4.3: a large scan target, a torch
 * toggle, and manual entry **always beside it and permanently tagged as
 * such**. `barcode_raw` is never normalised in place (v02 §3) — whatever the
 * scanner or the keyboard produced is what gets stored; symbology and
 * capture method travel alongside it, not baked into the string.
 *
 * DataWedge-injectable: the manual-entry `<input>` is a plain controlled
 * text field with no `readOnly`/synthetic-event blocking, so a Zebra
 * TC-series scanner configured as a keyboard-wedge (§4.3) types into it like
 * any other keyboard input — no separate code path needed for that hardware.
 */

import React, { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import type { IScannerControls } from '@zxing/browser';
import { Button, Input, Badge, SEMANTIC_COLORS, SPACING } from '@app/components/index.js';
import type { BarcodeCaptureMethod } from '@shared/contract/common.js';

export interface BarcodeFieldProps {
  value: string;
  captureMethod: BarcodeCaptureMethod | null;
  /** Advisory only (contract: "never used to reject a scan") — a soft badge, not a gate. */
  barcodePattern?: string | null;
  onChange: (value: string, method: BarcodeCaptureMethod) => void;
  disabled?: boolean;
}

export function BarcodeField({
  value,
  captureMethod,
  barcodePattern,
  onChange,
  disabled = false,
}: BarcodeFieldProps): React.JSX.Element {
  const [scanning, setScanning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);

  useEffect(() => {
    return () => {
      controlsRef.current?.stop();
    };
  }, []);

  const startScan = async () => {
    setError(null);
    setScanning(true);
    if (!readerRef.current) readerRef.current = new BrowserMultiFormatReader();
    try {
      const controls = await readerRef.current.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        videoRef.current ?? undefined,
        (result, err) => {
          if (result) {
            onChange(result.getText(), 'scan');
            controlsRef.current?.stop();
            setScanning(false);
          }
          // A per-frame NotFoundException is the normal "still looking"
          // state, not an error worth surfacing — only a hard decode
          // failure (camera lost) reaches the outer catch below.
          void err;
        },
      );
      controlsRef.current = controls;
      const track = videoRef.current?.srcObject instanceof MediaStream ? videoRef.current.srcObject.getVideoTracks()[0] : undefined;
      setTorchSupported(!!track && BrowserMultiFormatReader.mediaStreamIsTorchCompatibleTrack(track));
    } catch (err) {
      setScanning(false);
      setError(err instanceof Error ? err.message : 'Camera unavailable for scanning.');
    }
  };

  const stopScan = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    setScanning(false);
    setTorchOn(false);
  };

  const toggleTorch = async () => {
    const next = !torchOn;
    try {
      await controlsRef.current?.switchTorch?.(next);
      setTorchOn(next);
    } catch {
      setTorchSupported(false);
    }
  };

  const patternOk = !barcodePattern || !value ? null : new RegExp(barcodePattern).test(value);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACING.md }}>
      <div style={{ display: 'flex', gap: SPACING.md, flexWrap: 'wrap' }}>
        {!scanning ? (
          <Button type="button" variant="primary" size="md" onClick={startScan} disabled={disabled}>
            Scan barcode
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" size="md" onClick={stopScan}>
              Stop scanning
            </Button>
            {torchSupported && (
              <Button type="button" variant={torchOn ? 'primary' : 'secondary'} size="md" onClick={toggleTorch}>
                {torchOn ? 'Torch on' : 'Torch off'}
              </Button>
            )}
          </>
        )}
      </div>

      {scanning && (
        <video
          ref={videoRef}
          aria-label="Barcode scanner viewfinder"
          style={{
            width: '100%',
            maxHeight: 240,
            borderRadius: 8,
            background: '#000',
            objectFit: 'cover',
          }}
          muted
          playsInline
        />
      )}

      {error && <Badge label={error} status="error" />}

      {/* Manual entry — always present beside the scanner, never hidden
          behind a toggle, and permanently tagged as manual when used. */}
      <Input
        label="Barcode (scan or type)"
        value={value}
        onChange={(e) => onChange(e.target.value, 'manual_entry')}
        placeholder="Scan above, or type the label exactly as printed"
        disabled={disabled}
        suffix={
          captureMethod ? (
            <Badge
              label={captureMethod === 'scan' ? 'Scanned' : 'Manual entry'}
              status={captureMethod === 'scan' ? 'success' : 'info'}
              size="sm"
            />
          ) : undefined
        }
      />
      {patternOk === false && (
        <span style={{ fontSize: 12, color: SEMANTIC_COLORS.textSecondary }}>
          Doesn&rsquo;t match this lab&rsquo;s usual label format — saved as scanned, not blocked.
        </span>
      )}
    </div>
  );
}
