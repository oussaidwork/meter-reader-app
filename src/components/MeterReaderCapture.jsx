import { useEffect, useMemo, useRef, useState } from "react";
import { recognize } from "tesseract.js";

const ACCEPTED_IMAGE_TYPES = "image/png,image/jpeg,image/webp";

export default function MeterReaderCapture({
  endpoint = "/api/read",
  title = "Mechanical Meter Reader",
  expectedDigits = 6,
  onResult,
}) {
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [reading, setReading] = useState("");
  const [confidence, setConfidence] = useState(null);
  const [rawResponse, setRawResponse] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [useBackendApi, setUseBackendApi] = useState(false);
  const [autoReadOnFocus, setAutoReadOnFocus] = useState(true);
  const [autoReadStatus, setAutoReadStatus] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [isPreCroppedCapture, setIsPreCroppedCapture] = useState(false);
  const streamRef = useRef(null);
  const videoRef = useRef(null);
  const galleryInputRef = useRef(null);
  const autoReadTimerRef = useRef(null);
  const autoReadBusyRef = useRef(false);
  const stableReadingRef = useRef({ value: "", count: 0 });
  const [cropPercent, setCropPercent] = useState({
    left: 5,
    top: 25,
    width: 90,
    height: 45,
  });

  const hasResult = useMemo(() => reading !== "", [reading]);

  useEffect(() => {
    return () => {
      if (previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
      stopCamera();
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!cameraOpen || !videoRef.current || !streamRef.current) {
      return;
    }
    videoRef.current.srcObject = streamRef.current;
    videoRef.current
      .play()
      .catch(() => setError("Camera preview could not start. Check browser permissions."));
  }, [cameraOpen]);

  useEffect(() => {
    if (!cameraOpen || !cameraReady || useBackendApi || !autoReadOnFocus) {
      if (autoReadTimerRef.current) {
        clearInterval(autoReadTimerRef.current);
        autoReadTimerRef.current = null;
      }
      return;
    }

    setAutoReadStatus("Align counter inside green frame...");
    autoReadTimerRef.current = setInterval(() => {
      autoReadFromCameraFrame();
    }, 1300);

    return () => {
      if (autoReadTimerRef.current) {
        clearInterval(autoReadTimerRef.current);
        autoReadTimerRef.current = null;
      }
    };
  }, [cameraOpen, cameraReady, useBackendApi, autoReadOnFocus]);

  function normalizeReading(value) {
    return String(value || "").replace(/[^\d]/g, "");
  }

  function scoreCandidate(candidateDigits, confidenceValue) {
    if (!candidateDigits) {
      return -9999;
    }
    const length = candidateDigits.length;
    const distanceToExpected = Math.abs(length - expectedDigits);
    const lengthScore = Math.max(0, 30 - distanceToExpected * 6);
    return Number(confidenceValue || 0) + lengthScore;
  }

  function estimateFocusScore(sourceCanvas) {
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 180;
    sampleCanvas.height = 80;
    const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return 0;
    }
    ctx.drawImage(sourceCanvas, 0, 0, sampleCanvas.width, sampleCanvas.height);
    const imageData = ctx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height);
    const data = imageData.data;

    let sumDiff = 0;
    let count = 0;
    const rowStride = sampleCanvas.width * 4;
    for (let y = 1; y < sampleCanvas.height; y += 1) {
      for (let x = 1; x < sampleCanvas.width; x += 1) {
        const i = y * rowStride + x * 4;
        const left = i - 4;
        const up = i - rowStride;
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const grayLeft =
          0.299 * data[left] + 0.587 * data[left + 1] + 0.114 * data[left + 2];
        const grayUp = 0.299 * data[up] + 0.587 * data[up + 1] + 0.114 * data[up + 2];
        sumDiff += Math.abs(gray - grayLeft) + Math.abs(gray - grayUp);
        count += 1;
      }
    }
    return count > 0 ? sumDiff / count : 0;
  }

  async function loadImageFromFile(sourceFile) {
    const imageUrl = URL.createObjectURL(sourceFile);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Could not load image for OCR."));
        img.src = imageUrl;
      });
      return image;
    } finally {
      URL.revokeObjectURL(imageUrl);
    }
  }

  function createCroppedCanvas(image) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas not available.");
    }

    if (isPreCroppedCapture) {
      const scale = 3;
      canvas.width = Math.max(1, Math.floor(image.width * scale));
      canvas.height = Math.max(1, Math.floor(image.height * scale));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    }

    const x = Math.floor((cropPercent.left / 100) * image.width);
    const y = Math.floor((cropPercent.top / 100) * image.height);
    const w = Math.floor((cropPercent.width / 100) * image.width);
    const h = Math.floor((cropPercent.height / 100) * image.height);

    if (w <= 0 || h <= 0) {
      throw new Error("Invalid crop area.");
    }

    const scale = 3;
    canvas.width = Math.max(1, Math.floor(w * scale));
    canvas.height = Math.max(1, Math.floor(h * scale));
    ctx.drawImage(image, x, y, w, h, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function cloneCanvas(sourceCanvas) {
    const canvas = document.createElement("canvas");
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas not available.");
    }
    ctx.drawImage(sourceCanvas, 0, 0);
    return canvas;
  }

  function preprocessVariant(sourceCanvas, variant) {
    const canvas = cloneCanvas(sourceCanvas);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas not available.");
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;

    let meanGray = 0;
    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      meanGray += gray;
    }
    meanGray /= Math.max(1, data.length / 4);

    const threshold = Math.min(190, Math.max(70, meanGray * 0.95));

    for (let index = 0; index < data.length; index += 4) {
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;

      if (variant === "gray") {
        const boosted = Math.min(255, Math.max(0, (gray - threshold) * 2 + 128));
        data[index] = boosted;
        data[index + 1] = boosted;
        data[index + 2] = boosted;
      } else if (variant === "bw-dark-digits") {
        const bw = gray < threshold ? 0 : 255;
        data[index] = bw;
        data[index + 1] = bw;
        data[index + 2] = bw;
      } else if (variant === "bw-light-digits") {
        const bw = gray > threshold ? 0 : 255;
        data[index] = bw;
        data[index + 1] = bw;
        data[index + 2] = bw;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  async function readWithBrowserOcr(sourceFile) {
    const image = await loadImageFromFile(sourceFile);
    const baseCanvas = createCroppedCanvas(image);
    return readDigitsFromCanvas(baseCanvas);
  }

  async function readDigitsFromCanvas(baseCanvas) {
    const variants = [
      { name: "original", canvas: baseCanvas },
      { name: "gray", canvas: preprocessVariant(baseCanvas, "gray") },
      {
        name: "bw-dark-digits",
        canvas: preprocessVariant(baseCanvas, "bw-dark-digits"),
      },
      {
        name: "bw-light-digits",
        canvas: preprocessVariant(baseCanvas, "bw-light-digits"),
      },
    ];
    const psmModes = [7, 6, 13];

    let best = null;
    const attempts = [];

    for (const variant of variants) {
      for (const psm of psmModes) {
        const ocrResult = await recognize(variant.canvas, "eng", {
          tessedit_pageseg_mode: psm,
          tessedit_char_whitelist: "0123456789",
        });

        const textDigits = normalizeReading(ocrResult?.data?.text || "");
        const confidenceValue = Number(ocrResult?.data?.confidence || 0);
        const score = scoreCandidate(textDigits, confidenceValue);
        const attempt = {
          variant: variant.name,
          psm,
          text: ocrResult?.data?.text || "",
          digits: textDigits,
          confidence: confidenceValue / 100,
          score,
        };
        attempts.push(attempt);

        if (!best || attempt.score > best.score) {
          best = attempt;
        }
      }
    }

    if (!best?.digits) {
      throw new Error(
        "OCR could not detect digits. Adjust crop sliders to include only the counter window."
      );
    }

    return {
      reading: best.digits,
      confidence: best.confidence,
      source: "browser-ocr",
      bestVariant: best.variant,
      bestPsm: best.psm,
      attempts,
    };
  }

  function getRoiCanvasFromVideo() {
    if (!videoRef.current) {
      return null;
    }
    const video = videoRef.current;
    const width = video.videoWidth || 0;
    const height = video.videoHeight || 0;
    if (!width || !height) {
      return null;
    }

    const cropX = Math.floor((cropPercent.left / 100) * width);
    const cropY = Math.floor((cropPercent.top / 100) * height);
    const cropW = Math.max(1, Math.floor((cropPercent.width / 100) * width));
    const cropH = Math.max(1, Math.floor((cropPercent.height / 100) * height));
    const clippedCropW = Math.min(cropW, width - cropX);
    const clippedCropH = Math.min(cropH, height - cropY);

    const canvas = document.createElement("canvas");
    canvas.width = clippedCropW;
    canvas.height = clippedCropH;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return null;
    }
    ctx.drawImage(
      video,
      cropX,
      cropY,
      clippedCropW,
      clippedCropH,
      0,
      0,
      clippedCropW,
      clippedCropH
    );
    return canvas;
  }

  async function autoReadFromCameraFrame() {
    if (autoReadBusyRef.current || !cameraOpen || !cameraReady || useBackendApi) {
      return;
    }
    autoReadBusyRef.current = true;
    try {
      const roiCanvas = getRoiCanvasFromVideo();
      if (!roiCanvas) {
        return;
      }

      const focusScore = estimateFocusScore(roiCanvas);
      if (focusScore < 20) {
        setAutoReadStatus("Hold steady... waiting for sharp focus");
        return;
      }

      setAutoReadStatus("Focused. Reading digits...");
      const localData = await readDigitsFromCanvas(roiCanvas);
      const nextReading = String(localData.reading || "");
      if (!nextReading) {
        setAutoReadStatus("Focused, but no digits yet");
        return;
      }

      if (stableReadingRef.current.value === nextReading) {
        stableReadingRef.current.count += 1;
      } else {
        stableReadingRef.current = { value: nextReading, count: 1 };
      }

      setReading(nextReading);
      setConfidence(localData.confidence);
      setRawResponse({ ...localData, mode: "camera-auto" });
      onResult?.({ ...localData, mode: "camera-auto" });

      if (stableReadingRef.current.count >= 2) {
        setAutoReadStatus(`Locked: ${nextReading}`);
        closeLiveCamera();
      } else {
        setAutoReadStatus(`Detected ${nextReading} (confirming...)`);
      }
    } catch {
      setAutoReadStatus("Focused, retrying...");
    } finally {
      autoReadBusyRef.current = false;
    }
  }

  function updateCrop(field, value) {
    const nextValue = Math.max(0, Math.min(100, Number(value)));
    setCropPercent((prev) => {
      const next = { ...prev, [field]: nextValue };
      if (next.left + next.width > 100) {
        next.width = 100 - next.left;
      }
      if (next.top + next.height > 100) {
        next.height = 100 - next.top;
      }
      return next;
    });
  }

  function handleFileChange(event) {
    const selectedFile = event.target.files?.[0] || null;
    setFile(selectedFile);
    setError("");
    setReading("");
    setConfidence(null);
    setRawResponse(null);
    setIsPreCroppedCapture(false);

    if (selectedFile) {
      if (previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
      const localPreview = URL.createObjectURL(selectedFile);
      setPreviewUrl(localPreview);
      return;
    }

    setPreviewUrl("");
  }

  function stopCamera() {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    setCameraReady(false);
    stableReadingRef.current = { value: "", count: 0 };
    if (autoReadTimerRef.current) {
      clearInterval(autoReadTimerRef.current);
      autoReadTimerRef.current = null;
    }
  }

  async function openLiveCamera() {
    setError("");
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      setAutoReadStatus("");
    } catch {
      setError(
        "Could not open camera. Please allow camera permission or use gallery upload."
      );
    }
  }

  function closeLiveCamera() {
    stopCamera();
    setCameraOpen(false);
    setAutoReadStatus("");
  }

  async function takePhotoFromCamera() {
    if (!videoRef.current) {
      return;
    }
    setCapturing(true);
    try {
      const video = videoRef.current;
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = width;
      fullCanvas.height = height;
      const ctx = fullCanvas.getContext("2d");
      if (!ctx) {
        throw new Error("Could not capture frame.");
      }
      ctx.drawImage(video, 0, 0, width, height);

      const cropX = Math.floor((cropPercent.left / 100) * width);
      const cropY = Math.floor((cropPercent.top / 100) * height);
      const cropW = Math.max(1, Math.floor((cropPercent.width / 100) * width));
      const cropH = Math.max(1, Math.floor((cropPercent.height / 100) * height));

      const clippedCropW = Math.min(cropW, width - cropX);
      const clippedCropH = Math.min(cropH, height - cropY);

      const croppedCanvas = document.createElement("canvas");
      croppedCanvas.width = clippedCropW;
      croppedCanvas.height = clippedCropH;
      const croppedCtx = croppedCanvas.getContext("2d");
      if (!croppedCtx) {
        throw new Error("Could not crop captured frame.");
      }
      croppedCtx.drawImage(
        fullCanvas,
        cropX,
        cropY,
        clippedCropW,
        clippedCropH,
        0,
        0,
        clippedCropW,
        clippedCropH
      );

      const blob = await new Promise((resolve) =>
        croppedCanvas.toBlob(resolve, "image/jpeg", 0.95)
      );
      if (!blob) {
        throw new Error("Camera capture failed.");
      }
      const capturedFile = new File([blob], `meter-${Date.now()}.jpg`, {
        type: "image/jpeg",
      });

      setFile(capturedFile);
      setReading("");
      setConfidence(null);
      setRawResponse(null);
      setError("");
      setIsPreCroppedCapture(true);
      if (previewUrl.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
      setPreviewUrl(URL.createObjectURL(capturedFile));
      closeLiveCamera();
    } catch (captureError) {
      setError(captureError.message || "Unable to capture photo.");
    } finally {
      setCapturing(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!file) {
      setError("Select an image first.");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      if (!useBackendApi) {
        const localData = await readWithBrowserOcr(file);
        setReading(String(localData.reading));
        setConfidence(localData.confidence);
        setRawResponse(localData);
        onResult?.(localData);
        return;
      }

      const payload = new FormData();
      payload.append("image", file);

      const response = await fetch(endpoint, {
        method: "POST",
        body: payload,
      });

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const data = await response.json();

      // Different projects can return different field names.
      const detectedReading = normalizeReading(
        data.reading ?? data.value ?? data.result ?? data.digits?.join?.("") ?? ""
      );
      const detectedConfidence = data.confidence ?? data.score ?? null;

      if (!detectedReading) {
        throw new Error(
          "API returned no digits. Verify backend response format."
        );
      }

      setReading(String(detectedReading));
      setConfidence(detectedConfidence);
      setRawResponse(data);
      onResult?.(data);
    } catch (requestError) {
      setError(requestError.message || "Could not read meter image.");
    } finally {
      setIsLoading(false);
    }
  }

  function openGalleryPicker() {
    galleryInputRef.current?.click();
  }

  return (
    <section style={styles.card}>
      <h2 style={styles.title}>{title}</h2>
      <p style={styles.subtitle}>
        Use your phone camera or upload a photo focused on the mechanical digits area.
      </p>

      <form onSubmit={handleSubmit} style={styles.form}>
        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={useBackendApi}
            onChange={(event) => setUseBackendApi(event.target.checked)}
          />
          Use backend API (optional)
        </label>

        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={autoReadOnFocus}
            onChange={(event) => setAutoReadOnFocus(event.target.checked)}
            disabled={useBackendApi}
          />
          Auto read when focused
        </label>

        {!useBackendApi && (
          <div style={styles.cropPanel}>
            <p style={styles.cropTitle}>Counter crop (for better OCR)</p>
            <label style={styles.sliderLabel}>
              Left {cropPercent.left}%
              <input
                type="range"
                min="0"
                max="100"
                value={cropPercent.left}
                onChange={(event) => updateCrop("left", event.target.value)}
              />
            </label>
            <label style={styles.sliderLabel}>
              Top {cropPercent.top}%
              <input
                type="range"
                min="0"
                max="100"
                value={cropPercent.top}
                onChange={(event) => updateCrop("top", event.target.value)}
              />
            </label>
            <label style={styles.sliderLabel}>
              Width {cropPercent.width}%
              <input
                type="range"
                min="1"
                max="100"
                value={cropPercent.width}
                onChange={(event) => updateCrop("width", event.target.value)}
              />
            </label>
            <label style={styles.sliderLabel}>
              Height {cropPercent.height}%
              <input
                type="range"
                min="1"
                max="100"
                value={cropPercent.height}
                onChange={(event) => updateCrop("height", event.target.value)}
              />
            </label>
          </div>
        )}

        <div style={styles.inputGroup}>
          <button type="button" onClick={openLiveCamera} style={styles.secondaryButton}>
            Capture with camera
          </button>

          <button type="button" onClick={openGalleryPicker} style={styles.secondaryButton}>
            Or pick from gallery
          </button>
          <input
            ref={galleryInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES}
            onChange={handleFileChange}
            style={styles.hiddenInput}
          />
        </div>

        <button type="submit" disabled={isLoading} style={styles.button}>
          {isLoading ? "Reading..." : "Read Meter"}
        </button>
      </form>

      {cameraOpen && (
        <div style={styles.cameraPanel}>
          <div style={styles.cameraFrame}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={() => setCameraReady(true)}
              style={styles.cameraVideo}
            />
            <div
              style={{
                ...styles.cameraCropOverlay,
                left: `${cropPercent.left}%`,
                top: `${cropPercent.top}%`,
                width: `${cropPercent.width}%`,
                height: `${cropPercent.height}%`,
              }}
            />
          </div>
          <div style={styles.cameraActions}>
            <button
              type="button"
              onClick={takePhotoFromCamera}
              disabled={!cameraReady || capturing}
              style={styles.button}
            >
              {capturing ? "Capturing..." : "Take Photo"}
            </button>
            <button type="button" onClick={closeLiveCamera} style={styles.secondaryButton}>
              Cancel
            </button>
          </div>
          {autoReadOnFocus && !useBackendApi && (
            <p style={styles.autoReadStatus}>{autoReadStatus}</p>
          )}
        </div>
      )}

      {previewUrl && (
        <div style={styles.previewWrap}>
          <img src={previewUrl} alt="Meter preview" style={styles.previewImage} />
          {!useBackendApi && (
            <div
              style={{
                ...styles.cropOverlay,
                left: `${cropPercent.left}%`,
                top: `${cropPercent.top}%`,
                width: `${cropPercent.width}%`,
                height: `${cropPercent.height}%`,
              }}
            />
          )}
        </div>
      )}

      {error && <p style={styles.error}>{error}</p>}

      {hasResult && (
        <div style={styles.result}>
          <p style={styles.reading}>Detected value: {reading}</p>
          {confidence !== null && (
            <p style={styles.confidence}>
              Confidence: {(Number(confidence) * 100).toFixed(1)}%
            </p>
          )}
        </div>
      )}

      {rawResponse && (
        <details style={styles.debug}>
          <summary>Raw response</summary>
          <pre style={styles.pre}>{JSON.stringify(rawResponse, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

const styles = {
  card: {
    maxWidth: 520,
    margin: "24px auto",
    padding: 20,
    border: "1px solid #d9d9d9",
    borderRadius: 12,
    background: "#fff",
    fontFamily: "Inter, Segoe UI, Arial, sans-serif",
  },
  title: {
    margin: "0 0 8px",
    fontSize: 22,
  },
  subtitle: {
    margin: "0 0 16px",
    color: "#555",
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 14,
    color: "#333",
  },
  inputGroup: {
    display: "grid",
    gap: 10,
  },
  secondaryButton: {
    cursor: "pointer",
    border: "1px solid #bbb",
    borderRadius: 10,
    padding: "10px 12px",
    background: "#fff",
    color: "#222",
    fontWeight: 600,
  },
  hiddenInput: {
    display: "none",
  },
  cameraPanel: {
    marginTop: 12,
    border: "1px solid #d5d5d5",
    borderRadius: 10,
    overflow: "hidden",
    background: "#111",
  },
  cameraFrame: {
    position: "relative",
  },
  cameraVideo: {
    display: "block",
    width: "100%",
    maxHeight: 360,
    objectFit: "contain",
    background: "#000",
  },
  cameraActions: {
    display: "flex",
    gap: 10,
    padding: 10,
    background: "#fff",
  },
  autoReadStatus: {
    margin: 0,
    padding: "8px 10px 12px",
    fontSize: 13,
    background: "#fff",
    color: "#1d3c78",
  },
  fileInput: {
    padding: 8,
    border: "1px solid #bbb",
    borderRadius: 8,
    background: "#fafafa",
  },
  button: {
    cursor: "pointer",
    border: "none",
    borderRadius: 10,
    padding: "10px 14px",
    background: "#1769e0",
    color: "#fff",
    fontWeight: 600,
  },
  previewWrap: {
    position: "relative",
    marginTop: 16,
    border: "1px solid #eee",
    borderRadius: 10,
    overflow: "hidden",
  },
  cropOverlay: {
    position: "absolute",
    border: "2px solid #19a15f",
    boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.25)",
    pointerEvents: "none",
  },
  cameraCropOverlay: {
    position: "absolute",
    border: "2px solid #19a15f",
    pointerEvents: "none",
  },
  cropPanel: {
    border: "1px solid #d8e9dc",
    background: "#f7fcf8",
    borderRadius: 8,
    padding: 10,
    display: "grid",
    gap: 8,
  },
  cropTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 700,
    color: "#255f3c",
  },
  sliderLabel: {
    display: "grid",
    gap: 4,
    fontSize: 13,
    color: "#333",
  },
  previewImage: {
    display: "block",
    width: "100%",
    height: "auto",
  },
  result: {
    marginTop: 16,
    background: "#f4f8ff",
    border: "1px solid #d5e4ff",
    borderRadius: 10,
    padding: 12,
  },
  reading: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
  },
  confidence: {
    margin: "6px 0 0",
    color: "#1d3c78",
  },
  error: {
    marginTop: 12,
    color: "#b00020",
    fontWeight: 600,
  },
  debug: {
    marginTop: 14,
  },
  pre: {
    marginTop: 8,
    padding: 10,
    background: "#f7f7f7",
    borderRadius: 8,
    overflowX: "auto",
  },
};
