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
  const [cropDetectStatus, setCropDetectStatus] = useState("");
  const [isDetectingCrop, setIsDetectingCrop] = useState(false);
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

  function detectDigitRegionFromCanvas(sourceCanvas) {
    const maxWidth = 480;
    const scale = sourceCanvas.width > maxWidth ? maxWidth / sourceCanvas.width : 1;
    const scaledWidth = Math.max(1, Math.floor(sourceCanvas.width * scale));
    const scaledHeight = Math.max(1, Math.floor(sourceCanvas.height * scale));

    const workCanvas = document.createElement("canvas");
    workCanvas.width = scaledWidth;
    workCanvas.height = scaledHeight;
    const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
    if (!workCtx) {
      return null;
    }
    workCtx.drawImage(sourceCanvas, 0, 0, scaledWidth, scaledHeight);
    const imageData = workCtx.getImageData(0, 0, scaledWidth, scaledHeight);
    const { data } = imageData;

    const pixelCount = scaledWidth * scaledHeight;
    const gray = new Float32Array(pixelCount);
    let sumGray = 0;
    for (let i = 0, p = 0; i < pixelCount; i += 1, p += 4) {
      const value = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      gray[i] = value;
      sumGray += value;
    }

    const meanGray = sumGray / Math.max(1, pixelCount);
    const threshold = Math.max(45, Math.min(200, meanGray * 0.9));
    const binary = new Uint8Array(pixelCount);

    let darkCount = 0;
    for (let i = 0; i < pixelCount; i += 1) {
      if (gray[i] < threshold) {
        binary[i] = 1;
        darkCount += 1;
      }
    }

    const darkRatio = darkCount / Math.max(1, pixelCount);
    if (darkRatio < 0.01 || darkRatio > 0.65) {
      return null;
    }

    const visited = new Uint8Array(pixelCount);
    const candidates = [];
    const minArea = Math.max(25, Math.floor(pixelCount * 0.0002));
    const stack = [];

    for (let y = 0; y < scaledHeight; y += 1) {
      for (let x = 0; x < scaledWidth; x += 1) {
        const start = y * scaledWidth + x;
        if (!binary[start] || visited[start]) {
          continue;
        }

        stack.length = 0;
        stack.push(start);
        visited[start] = 1;
        let area = 0;
        let minX = x;
        let maxX = x;
        let minY = y;
        let maxY = y;

        while (stack.length > 0) {
          const index = stack.pop();
          const px = index % scaledWidth;
          const py = Math.floor(index / scaledWidth);
          area += 1;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;

          const neighbors = [
            index - 1,
            index + 1,
            index - scaledWidth,
            index + scaledWidth,
          ];
          for (const next of neighbors) {
            if (next < 0 || next >= pixelCount || visited[next] || !binary[next]) {
              continue;
            }
            const nx = next % scaledWidth;
            const ny = Math.floor(next / scaledWidth);
            if (Math.abs(nx - px) > 1 || Math.abs(ny - py) > 1) {
              continue;
            }
            visited[next] = 1;
            stack.push(next);
          }
        }

        if (area < minArea) {
          continue;
        }
        candidates.push({
          minX,
          minY,
          maxX,
          maxY,
          area,
        });
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    let best = null;
    for (const candidate of candidates) {
      const width = candidate.maxX - candidate.minX + 1;
      const height = candidate.maxY - candidate.minY + 1;
      const bboxArea = width * height;
      const fillRatio = candidate.area / Math.max(1, bboxArea);
      const aspect = width / Math.max(1, height);
      const widthCoverage = width / Math.max(1, scaledWidth);
      const centerY = (candidate.minY + candidate.maxY) / 2;
      const verticalOffset = Math.abs(centerY / scaledHeight - 0.45);
      const areaScore = Math.min(40, (candidate.area / pixelCount) * 500);
      const aspectScore = Math.max(0, 25 - Math.abs(aspect - 3.4) * 8);
      const coverageScore = Math.max(0, 22 - Math.abs(widthCoverage - 0.55) * 42);
      const fillScore = Math.max(0, 18 - Math.abs(fillRatio - 0.32) * 55);
      const yScore = Math.max(0, 14 - verticalOffset * 40);
      const score = areaScore + aspectScore + coverageScore + fillScore + yScore;

      if (!best || score > best.score) {
        best = { ...candidate, score };
      }
    }

    if (!best || best.score < 30) {
      return null;
    }

    const paddingX = Math.floor((best.maxX - best.minX + 1) * 0.15);
    const paddingY = Math.floor((best.maxY - best.minY + 1) * 0.35);
    const minX = Math.max(0, best.minX - paddingX);
    const maxX = Math.min(scaledWidth - 1, best.maxX + paddingX);
    const minY = Math.max(0, best.minY - paddingY);
    const maxY = Math.min(scaledHeight - 1, best.maxY + paddingY);

    return {
      left: (minX / scaledWidth) * 100,
      top: (minY / scaledHeight) * 100,
      width: ((maxX - minX + 1) / scaledWidth) * 100,
      height: ((maxY - minY + 1) / scaledHeight) * 100,
      confidence: Math.min(1, best.score / 90),
    };
  }

  function applyAutoCropPercent(nextCrop) {
    if (!nextCrop) {
      return false;
    }
    const clamped = {
      left: Math.max(0, Math.min(100, Number(nextCrop.left))),
      top: Math.max(0, Math.min(100, Number(nextCrop.top))),
      width: Math.max(12, Math.min(100, Number(nextCrop.width))),
      height: Math.max(12, Math.min(100, Number(nextCrop.height))),
    };
    if (clamped.left + clamped.width > 100) {
      clamped.width = Math.max(12, 100 - clamped.left);
    }
    if (clamped.top + clamped.height > 100) {
      clamped.height = Math.max(12, 100 - clamped.top);
    }
    setCropPercent(clamped);
    return true;
  }

  async function detectAndApplyCropFromFile(sourceFile) {
    if (!sourceFile || useBackendApi) {
      return false;
    }
    setIsDetectingCrop(true);
    setCropDetectStatus("Detecting digits area...");
    try {
      const image = await loadImageFromFile(sourceFile);
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        setCropDetectStatus("Auto detect unavailable on this device.");
        return false;
      }
      ctx.drawImage(image, 0, 0, image.width, image.height);
      const detected = detectDigitRegionFromCanvas(canvas);
      if (!detected || !applyAutoCropPercent(detected)) {
        setCropDetectStatus("Could not auto-detect digits. Adjust crop manually.");
        return false;
      }
      setCropDetectStatus(
        `Digits area detected (${Math.round(detected.confidence * 100)}% confidence).`
      );
      return true;
    } catch {
      setCropDetectStatus("Auto detect failed. Adjust crop manually.");
      return false;
    } finally {
      setIsDetectingCrop(false);
    }
  }

  async function detectAndApplyCropFromCurrentPreview() {
    if (!file) {
      setCropDetectStatus("Select or capture an image first.");
      return;
    }
    await detectAndApplyCropFromFile(file);
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

  async function handleFileChange(event) {
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
      await detectAndApplyCropFromFile(selectedFile);
      return;
    }

    setCropDetectStatus("");
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
      setIsPreCroppedCapture(false);
      await detectAndApplyCropFromFile(capturedFile);
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
            <div style={styles.cropHeader}>
              <p style={styles.cropTitle}>Counter crop (for better OCR)</p>
              <button
                type="button"
                onClick={detectAndApplyCropFromCurrentPreview}
                disabled={isDetectingCrop}
                style={styles.detectButton}
              >
                {isDetectingCrop ? "Detecting..." : "Auto detect digits area"}
              </button>
            </div>
            {cropDetectStatus && <p style={styles.cropStatus}>{cropDetectStatus}</p>}
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
    maxWidth: 760,
    margin: "0 auto",
    padding: 28,
    border: "1px solid #d7dce5",
    borderRadius: 24,
    background: "linear-gradient(180deg, #ffffff 0%, #fdfdff 100%)",
    boxShadow: "0 24px 70px -36px rgba(21, 33, 56, 0.35)",
    fontFamily: "Segoe UI, Arial, sans-serif",
  },
  title: {
    margin: "0 0 10px",
    fontSize: 31,
    lineHeight: 1.1,
    fontWeight: 800,
    letterSpacing: "-0.03em",
    color: "#1a2232",
  },
  subtitle: {
    margin: "0 0 20px",
    color: "#4d5b74",
    fontSize: 15,
    lineHeight: 1.6,
    maxWidth: 600,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 14,
    color: "#2a354b",
    fontWeight: 500,
    padding: "10px 12px",
    borderRadius: 12,
    background: "#f7f9fc",
    border: "1px solid #e1e8f2",
  },
  inputGroup: {
    display: "grid",
    gap: 10,
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  },
  secondaryButton: {
    cursor: "pointer",
    border: "1px solid #c8d2e2",
    borderRadius: 12,
    padding: "11px 14px",
    background: "#ffffff",
    color: "#1f2a3d",
    fontWeight: 600,
    transition: "all 180ms ease",
    boxShadow: "0 4px 10px -8px rgba(42, 58, 89, 0.6)",
  },
  hiddenInput: {
    display: "none",
  },
  cameraPanel: {
    marginTop: 14,
    border: "1px solid #d3dbe8",
    borderRadius: 16,
    overflow: "hidden",
    background: "#0f1623",
  },
  cameraFrame: {
    position: "relative",
  },
  cameraVideo: {
    display: "block",
    width: "100%",
    maxHeight: 360,
    objectFit: "contain",
    background: "#0a101b",
  },
  cameraActions: {
    display: "flex",
    gap: 10,
    padding: 12,
    background: "#f7f9fc",
  },
  autoReadStatus: {
    margin: 0,
    padding: "9px 12px 12px",
    fontSize: 13,
    background: "#f7f9fc",
    color: "#284e92",
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
    borderRadius: 12,
    padding: "11px 16px",
    background: "linear-gradient(180deg, #1e73ea 0%, #1257d3 100%)",
    color: "#fff",
    fontWeight: 600,
    boxShadow: "0 12px 24px -14px rgba(18, 87, 211, 0.95)",
    transition: "transform 120ms ease, filter 120ms ease",
  },
  previewWrap: {
    position: "relative",
    marginTop: 18,
    border: "1px solid #d7deea",
    borderRadius: 16,
    overflow: "hidden",
    background: "#ffffff",
  },
  cropOverlay: {
    position: "absolute",
    border: "2px solid #1f9d61",
    boxShadow: "0 0 0 9999px rgba(6, 14, 31, 0.36)",
    pointerEvents: "none",
  },
  cameraCropOverlay: {
    position: "absolute",
    border: "2px solid #1f9d61",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.38)",
    pointerEvents: "none",
  },
  cropPanel: {
    border: "1px solid #d6e6dc",
    background: "linear-gradient(180deg, #f8fcfa 0%, #f3f9f4 100%)",
    borderRadius: 14,
    padding: 12,
    display: "grid",
    gap: 10,
  },
  cropHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  cropTitle: {
    margin: 0,
    fontSize: 14,
    fontWeight: 800,
    color: "#24573a",
    letterSpacing: "0.01em",
  },
  detectButton: {
    cursor: "pointer",
    border: "1px solid #b7c9de",
    borderRadius: 10,
    padding: "8px 10px",
    background: "#ffffff",
    color: "#22334a",
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  cropStatus: {
    margin: 0,
    fontSize: 12,
    color: "#406042",
    background: "#ecf6ee",
    border: "1px solid #cde4d0",
    borderRadius: 10,
    padding: "8px 10px",
  },
  sliderLabel: {
    display: "grid",
    gap: 6,
    fontSize: 13,
    color: "#2f3d54",
  },
  previewImage: {
    display: "block",
    width: "100%",
    height: "auto",
  },
  result: {
    marginTop: 18,
    background: "linear-gradient(180deg, #f3f8ff 0%, #ecf4ff 100%)",
    border: "1px solid #cde0ff",
    borderRadius: 14,
    padding: 14,
  },
  reading: {
    margin: 0,
    fontSize: 21,
    fontWeight: 800,
    color: "#0d2a56",
    letterSpacing: "0.01em",
  },
  confidence: {
    margin: "6px 0 0",
    color: "#214786",
    fontSize: 14,
  },
  error: {
    marginTop: 12,
    color: "#9c1b32",
    fontWeight: 700,
    background: "#fff2f5",
    border: "1px solid #ffd0da",
    borderRadius: 12,
    padding: "10px 12px",
  },
  debug: {
    marginTop: 16,
    borderTop: "1px solid #e3e8f1",
    paddingTop: 12,
  },
  pre: {
    marginTop: 8,
    padding: 12,
    background: "#f5f7fb",
    borderRadius: 12,
    overflowX: "auto",
    border: "1px solid #e3e8f2",
  },
};
