/**
 * Screen 6 · Storage (v02 §2, B12)
 *
 * Shows device storage usage:
 * - Used (photos, records, tiles, app itself)
 * - Free
 * - Action to reclaim space by deleting uploaded photos
 *
 * The device holds photos locally keyed by content hash until they are
 * verified uploaded, then marks them for deletion. This screen provides
 * manual control over the "reclaim uploaded photos" action.
 *
 * v02 §4.4: Steady state ~150–400 MB in flight (nightly sync); worst case
 * ~900 MB–1 GB (week of tolerance). Crew starts the week with ~3 GB free.
 */

import React, { useState, useEffect } from 'react';
import { Button, SPACING } from '@app/components/index.js';

interface StorageInfo {
  usedBytes: number;
  availableBytes: number;
  totalBytes: number;
}

export function StorageScreen() {
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [isReclaiming, setIsReclaiming] = useState(false);
  const [reclaimResult, setReclaimResult] = useState<string | null>(null);

  useEffect(() => {
    // Fetch storage info on mount
    updateStorageInfo();
  }, []);

  const updateStorageInfo = async () => {
    try {
      // Check if navigator.storage is available (web)
      if ('storage' in navigator && 'estimate' in navigator.storage) {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage ?? 0;
        const available = (estimate.quota ?? 0) - used;
        const total = estimate.quota ?? 0;

        setStorageInfo({
          usedBytes: used,
          availableBytes: available,
          totalBytes: total,
        });
      } else {
        // Fallback for environments without StorageManager API
        console.warn('StorageManager API not available');
        setStorageInfo({
          usedBytes: 0,
          availableBytes: 1000000000, // Assume 1 GB
          totalBytes: 1000000000,
        });
      }
    } catch (error) {
      console.error('Failed to get storage info:', error);
    }
  };

  const handleReclaimPhotos = async () => {
    setIsReclaiming(true);
    setReclaimResult(null);

    try {
      // TODO: Delete uploaded photos from OPFS
      // const db = useDeviceDb();
      // const deletedCount = await db.deleteUploadedPhotos();
      // setReclaimResult(`Deleted ${deletedCount} photos. Freed ${formatBytes(freedBytes)}`);
      // Then update storage info
      console.log('Reclaiming photos...');
      // For demo purposes:
      setReclaimResult('Reclaim feature not yet implemented (photo deletion pending database integration)');
      // updateStorageInfo();
    } catch (error) {
      console.error('Failed to reclaim photos:', error);
      setReclaimResult('Error: Failed to reclaim photos. Please try again.');
    } finally {
      setIsReclaiming(false);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  const usagePercent = storageInfo
    ? Math.round((storageInfo.usedBytes / storageInfo.totalBytes) * 100)
    : 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        backgroundColor: '#f5f5f0',
      }}
    >
      {/* Header */}
      <div
        style={{
          backgroundColor: '#fff',
          borderBottom: '1px solid #ddd',
          padding: SPACING.lg,
          textAlign: 'center',
        }}
      >
        <h1
          style={{
            fontSize: '18px',
            fontWeight: 700,
            margin: 0,
            color: '#333',
          }}
        >
          Storage
        </h1>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: SPACING.lg,
          display: 'flex',
          flexDirection: 'column',
          gap: SPACING.xl,
        }}
      >
        {storageInfo ? (
          <>
            {/* Storage gauge */}
            <section>
              <h2
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  margin: `0 0 ${SPACING.md} 0`,
                  color: '#333',
                }}
              >
                Device Storage
              </h2>

              {/* Progress bar */}
              <div
                style={{
                  width: '100%',
                  height: '20px',
                  backgroundColor: '#e0e0e0',
                  borderRadius: '10px',
                  overflow: 'hidden',
                  marginBottom: SPACING.md,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${usagePercent}%`,
                    backgroundColor:
                      usagePercent > 90 ? '#d32f2f' : usagePercent > 70 ? '#f57c00' : '#00897b',
                    transition: 'width 300ms ease-in-out',
                  }}
                />
              </div>

              {/* Stats grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: SPACING.md,
                }}
              >
                {/* Used */}
                <div
                  style={{
                    padding: SPACING.md,
                    backgroundColor: '#fff',
                    borderRadius: '6px',
                    border: '1px solid #ddd',
                  }}
                >
                  <p
                    style={{
                      fontSize: '12px',
                      color: '#666',
                      margin: 0,
                      marginBottom: SPACING.sm,
                      fontWeight: 500,
                    }}
                  >
                    Used
                  </p>
                  <p
                    style={{
                      fontSize: '18px',
                      fontWeight: 700,
                      margin: 0,
                      color: '#333',
                    }}
                  >
                    {formatBytes(storageInfo.usedBytes)}
                  </p>
                </div>

                {/* Free */}
                <div
                  style={{
                    padding: SPACING.md,
                    backgroundColor: '#fff',
                    borderRadius: '6px',
                    border: '1px solid #ddd',
                  }}
                >
                  <p
                    style={{
                      fontSize: '12px',
                      color: '#666',
                      margin: 0,
                      marginBottom: SPACING.sm,
                      fontWeight: 500,
                    }}
                  >
                    Free
                  </p>
                  <p
                    style={{
                      fontSize: '18px',
                      fontWeight: 700,
                      margin: 0,
                      color: '#333',
                    }}
                  >
                    {formatBytes(storageInfo.availableBytes)}
                  </p>
                </div>
              </div>
            </section>

            {/* Reclaim photos section */}
            <section>
              <h2
                style={{
                  fontSize: '14px',
                  fontWeight: 600,
                  margin: `0 0 ${SPACING.md} 0`,
                  color: '#333',
                }}
              >
                Free Up Space
              </h2>

              <div
                style={{
                  padding: SPACING.md,
                  backgroundColor: '#fff8f0',
                  border: '1px solid #d4a574',
                  borderRadius: '6px',
                  marginBottom: SPACING.md,
                }}
              >
                <p
                  style={{
                    fontSize: '13px',
                    margin: 0,
                    color: '#333',
                    lineHeight: 1.5,
                  }}
                >
                  Photos are stored locally until they are verified uploaded to the server. Once
                  uploaded and synced, you can safely delete them to free storage space.
                </p>
              </div>

              <Button
                variant="secondary"
                onClick={handleReclaimPhotos}
                disabled={isReclaiming}
                fullWidth={true}
                size="md"
              >
                {isReclaiming ? 'Reclaiming...' : 'Reclaim Uploaded Photos'}
              </Button>

              {reclaimResult && (
                <p
                  style={{
                    fontSize: '12px',
                    color: reclaimResult.startsWith('Error') ? '#d32f2f' : '#2e7d32',
                    marginTop: SPACING.md,
                    fontWeight: 500,
                  }}
                >
                  {reclaimResult}
                </p>
              )}
            </section>

            {/* Guidance */}
            <section
              style={{
                padding: SPACING.md,
                backgroundColor: '#e3f2fd',
                border: '1px solid #64b5f6',
                borderRadius: '6px',
              }}
            >
              <h3
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  margin: 0,
                  marginBottom: SPACING.sm,
                  color: '#1565c0',
                }}
              >
                Storage Guidance
              </h3>
              <p
                style={{
                  fontSize: '12px',
                  color: '#0d47a1',
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                Start each work week with approximately 3 GB free space. Plan points and photos
                are stored locally and synced nightly when connectivity is available.
              </p>
            </section>
          </>
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: '#666',
            }}
          >
            <p>Loading storage information...</p>
          </div>
        )}
      </div>
    </div>
  );
}

StorageScreen.displayName = 'StorageScreen';
