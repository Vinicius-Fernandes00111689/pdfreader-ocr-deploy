import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Upload,
  ScanText,
  Search,
  Download,
  Plus,
  ChevronUp,
  ChevronDown,
  X,
  FileText,
  Loader2,
  ZoomIn,
  ZoomOut,
  Highlighter,
  Sun,
  Moon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

// Lazy types – real modules are loaded dynamically on the client only,
// because pdf.js / tesseract.js / pdf-lib touch browser globals (DOMMatrix,
// Worker, document) that don't exist during SSR.
type PdfJsModule = typeof import("pdfjs-dist");
type PDFDocumentProxyT = import("pdfjs-dist").PDFDocumentProxy;

let pdfjsLibPromise: Promise<PdfJsModule> | null = null;
const loadPdfJs = (): Promise<PdfJsModule> => {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("pdf.js only runs in the browser"));
  }
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = (async () => {
      const lib = await import("pdfjs-dist");
      const PdfWorker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?worker")).default;
      (lib.GlobalWorkerOptions as { workerPort?: Worker }).workerPort = new PdfWorker();
      return lib;
    })();
  }
  return pdfjsLibPromise;
};

type WordBox = {
  text: string;
  // Coordinates in PDF points (origin top-left for our overlay)
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  source: "pdf" | "ocr";
};

type PageData = {
  pageNumber: number;
  width: number; // PDF point width
  height: number; // PDF point height
  words: WordBox[];
};

type Occurrence = {
  pageIndex: number;
  wordIndex: number;
};

type HighlightRegistry = {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
};

const TARGET_OCR_DPI = 240;
const MAX_OCR_CANVAS_PIXELS = 9_000_000;
const WORD_TOKEN_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;

const canonicalWord = (text: string) =>
  text.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

const getCssHighlights = (): HighlightRegistry | null => {
  if (typeof window === "undefined") return null;
  const maybeCss = CSS as unknown as { highlights?: HighlightRegistry };
  return maybeCss.highlights ?? null;
};

const createCssHighlight = (ranges: Range[]) => {
  const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown })
    .Highlight;
  return HighlightCtor ? new HighlightCtor(...ranges) : null;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const clipWordBox = (word: WordBox, pageWidth: number, pageHeight: number): WordBox | null => {
  const x = clamp(word.x, 0, pageWidth);
  const y = clamp(word.y, 0, pageHeight);
  const right = clamp(word.x + word.width, 0, pageWidth);
  const bottom = clamp(word.y + word.height, 0, pageHeight);
  const width = right - x;
  const height = bottom - y;
  if (width <= 0.5 || height <= 0.5) return null;
  return { ...word, x, y, width, height };
};

// Extrai palavras DIRETAMENTE do textContent do PDF.js, usando coordenadas
// reais do PDF (transform/width/height). NÃO usa DOM, getBoundingClientRect,
// Range nem TreeWalker — esses introduzem erro acumulado por zoom, reflow e
// transformações CSS do textLayer. Resultado: highlights pixel-perfect e
// sempre coerentes com o export via pdf-lib.
type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
};

const extractWordsFromTextContent = (
  textContent: { items: unknown[] },
  pageWidth: number,
  pageHeight: number,
): WordBox[] => {
  const words: WordBox[] = [];
  for (const raw of textContent.items) {
    const item = raw as PdfTextItem;
    if (!item?.str?.trim()) continue;
    if (!Array.isArray(item.transform) || item.transform.length < 6) continue;

    const text = canonicalWord(item.str);
    if (!text) continue;

    const tx = item.transform[4];
    const ty = item.transform[5];
    const height = item.height || Math.abs(item.transform[3]) || 10;
    const width = item.width || text.length * (height * 0.5);
    // PDF origin = bottom-left; overlay = top-left.
    const y = pageHeight - ty - height;
    const box = clipWordBox(
      { text, x: tx, y, width, height, confidence: 100, source: "pdf" },
      pageWidth,
      pageHeight,
    );
    if (box) words.push(box);
  }
  return words;
};

const renderPdfPageIntoContainer = async (
  pdfjsLib: PdfJsModule,
  page: Awaited<ReturnType<PDFDocumentProxyT["getPage"]>>,
  container: HTMLDivElement,
  zoom: number,
): Promise<{ width: number; height: number; words: WordBox[] }> => {
  const viewport = page.getViewport({ scale: zoom });
  const baseViewport = page.getViewport({ scale: 1 });
  const canvas = container.querySelector("canvas") as HTMLCanvasElement | null;
  const textLayerEl = container.querySelector('[data-pdf-text-layer="true"]') as HTMLElement | null;
  if (!canvas || !textLayerEl) {
    return { width: baseViewport.width, height: baseViewport.height, words: [] };
  }

  const ctx = canvas.getContext("2d")!;
  const cw = Math.floor(viewport.width);
  const ch = Math.floor(viewport.height);
  canvas.width = cw;
  canvas.height = ch;
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  textLayerEl.style.width = `${cw}px`;
  textLayerEl.style.height = `${ch}px`;
  textLayerEl.style.transformOrigin = "0 0";
  textLayerEl.replaceChildren();

  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const textContent = await page.getTextContent({
    disableCombineTextItems: true,
  } as Parameters<typeof page.getTextContent>[0]);

  return {
    width: baseViewport.width,
    height: baseViewport.height,
    words: extractWordsFromTextContent(textContent, baseViewport.width, baseViewport.height),
  };
};

export default function PdfOcrApp() {
  const [file, setFile] = useState<File | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxyT | null>(null);
  const [pages, setPages] = useState<PageData[]>([]);
  const [terms, setTerms] = useState<string[]>(["valor", "contrato", "prazo"]);
  const [termInput, setTermInput] = useState("");
  const [isOcrRunning, setIsOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(0);
  const [isLoadingPdf, setIsLoadingPdf] = useState(false);
  const [activeTerm, setActiveTerm] = useState<string | null>(null);
  const [activeOccurrenceIdx, setActiveOccurrenceIdx] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [isExporting, setIsExporting] = useState(false);
  const [isDark, setIsDark] = useState(false);
  const [supportsTextHighlights, setSupportsTextHighlights] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSupportsTextHighlights("Highlight" in window && "highlights" in CSS);
    const stored = localStorage.getItem("theme");
    const prefersDark =
      stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    setIsDark(prefersDark);
    document.documentElement.classList.toggle("dark", prefersDark);
  }, []);

  const toggleTheme = (next: boolean) => {
    setIsDark(next);
    document.documentElement.classList.toggle("dark", next);
    if (typeof window !== "undefined") {
      localStorage.setItem("theme", next ? "dark" : "light");
    }
  };

  const viewerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // ---------- Upload ----------
  const handleFile = useCallback(async (f: File) => {
    if (f.type !== "application/pdf") {
      toast.error("Envie um arquivo PDF.");
      return;
    }
    setIsLoadingPdf(true);
    setFile(f);
    setPages([]);
    setActiveTerm(null);
    try {
      const pdfjsLib = await loadPdfJs();
      const buf = await f.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buf }).promise;
      setPdfDoc(doc);
      // Fetch page metadata in parallel for faster load
      const meta = await Promise.all(
        Array.from({ length: doc.numPages }, async (_, idx) => {
          const page = await doc.getPage(idx + 1);
          const vp = page.getViewport({ scale: 1 });
          return {
            pageNumber: idx + 1,
            width: vp.width,
            height: vp.height,
            words: [] as WordBox[],
          };
        }),
      );
      setPages(meta);
      toast.success(`PDF carregado (${doc.numPages} página${doc.numPages > 1 ? "s" : ""})`);
    } catch (err) {
      console.error(err);
      toast.error("Falha ao carregar o PDF.");
      setFile(null);
      setPdfDoc(null);
    } finally {
      setIsLoadingPdf(false);
    }
  }, []);

  const isBusy = isOcrRunning || isLoadingPdf;

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (isBusy) return;
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (isBusy) return;
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  // ---------- Render PDF pages to canvases + real PDF.js text layer ----------
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;
    (async () => {
      const pdfjsLib = await loadPdfJs();
      // wait a tick so refs are mounted
      await Promise.resolve();
      for (let i = 1; i <= pdfDoc.numPages; i++) {
        if (cancelled) return;
        const page = await pdfDoc.getPage(i);
        const container = pageRefs.current.get(i);
        if (!container) continue;
        const rendered = await renderPdfPageIntoContainer(pdfjsLib, page, container, zoom);
        if (cancelled) return;
        setPages((prev) =>
          prev.map((p) =>
            p.pageNumber === i && rendered.words.length > 0
              ? { ...p, width: rendered.width, height: rendered.height, words: rendered.words }
              : { ...p, width: rendered.width, height: rendered.height },
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, zoom]);

  // ---------- OCR ----------
  const runOcr = async () => {
    if (!pdfDoc) {
      toast.error("Carregue um PDF primeiro.");
      return;
    }
    setIsOcrRunning(true);
    setOcrProgress(0);
    try {
      const pdfjsLib = await loadPdfJs();
      type TWord = {
        text: string;
        confidence?: number;
        bbox: { x0: number; y0: number; x1: number; y1: number };
      };
      const collectWords = (d: unknown): TWord[] => {
        const out: TWord[] = [];
        const dd = d as {
          words?: TWord[];
          blocks?: Array<{
            paragraphs?: Array<{
              lines?: Array<{ words?: TWord[] }>;
            }>;
          }>;
        };
        if (Array.isArray(dd.words) && dd.words.length > 0) {
          return dd.words;
        }
        for (const b of dd.blocks ?? []) {
          for (const p of b.paragraphs ?? []) {
            for (const ln of p.lines ?? []) {
              for (const w of ln.words ?? []) out.push(w);
            }
          }
        }
        return out;
      };

      const total = pdfDoc.numPages;
      const newPages: PageData[] = new Array(total);
      let done = 0;

      // PASS 1 — usa a camada de texto nativa do PDF com caixas reais do navegador.
      // Para PDFs digitais isso é mais rápido e mais fiel que OCR.
      const needsOcr: number[] = [];
      await Promise.all(
        Array.from({ length: total }, async (_, idx) => {
          const i = idx + 1;
          const page = await pdfDoc.getPage(i);
          try {
            const baseVp = page.getViewport({ scale: 1 });
            const textContent = await page.getTextContent();
            const words = extractWordsFromTextContent(
              textContent as unknown as { items: unknown[] },
              baseVp.width,
              baseVp.height,
            );
            newPages[idx] = {
              pageNumber: i,
              width: baseVp.width,
              height: baseVp.height,
              words,
            };
            // Heurística forte para detectar scans: além de pouca palavra,
            // verifica se o "texto" é apenas lixo simbólico ou muito curto.
            const extractedText = words
              .map((w) => w.text)
              .join(" ")
              .trim();
            const suspiciousText =
              extractedText.length < 30 ||
              /^[^a-zA-ZÀ-ÿ0-9]+$/.test(extractedText) ||
              words.length < 15;
            if (suspiciousText) {
              needsOcr.push(i);
            } else {
              done++;
              setOcrProgress(Math.round((done / total) * 100));
            }
          } catch {
            needsOcr.push(i);
          }
        }),
      );

      // PASS 2 — OCR só nas páginas que precisam (scans / imagens).
      if (needsOcr.length > 0) {
        const Tesseract = (await import("tesseract.js")).default;
        const hw = navigator.hardwareConcurrency || 4;
        const poolSize = Math.max(1, Math.min(hw, needsOcr.length, 6));
        const workers = await Promise.all(
          Array.from({ length: poolSize }, async () => {
            const w = await Tesseract.createWorker("por", 1, {
              // OEM 1 = LSTM only (mais preciso e rápido que legacy)
            });
            await w.setParameters({
              tessedit_pageseg_mode: "3" as unknown as never,
              preserve_interword_spaces: "1" as unknown as never,
              user_defined_dpi: String(TARGET_OCR_DPI) as unknown as never,
              tessedit_char_whitelist:
                "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ.,;:/ºª°%$€R()-_+" as unknown as never,
            });
            return w;
          }),
        );

        let cursor = 0;
        const runWorker = async (wIdx: number) => {
          const w = workers[wIdx];
          while (true) {
            const myIdx = cursor++;
            if (myIdx >= needsOcr.length) return;
            const i = needsOcr[myIdx];
            const page = await pdfDoc.getPage(i);
            const baseVp = page.getViewport({ scale: 1 });
            // Tesseract roda no navegador do usuário: escala alta melhora leitura, mas evita canvases gigantes.
            const dpiScale = TARGET_OCR_DPI / 72;
            const pixelLimitScale = Math.sqrt(
              MAX_OCR_CANVAS_PIXELS / (baseVp.width * baseVp.height),
            );
            const ocrScale = Math.max(1.75, Math.min(dpiScale, pixelLimitScale));
            const vp = page.getViewport({ scale: ocrScale });
            const off = document.createElement("canvas");
            off.width = vp.width;
            off.height = vp.height;
            const ctx = off.getContext("2d", { willReadFrequently: false })!;
            // Fundo branco (scans com transparência ficam pretos no Tesseract)
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, vp.width, vp.height);
            await page.render({ canvasContext: ctx, viewport: vp, canvas: off }).promise;
            const { data } = await w.recognize(off, {}, { blocks: true });
            const rawWords = collectWords(data);
            const sx = baseVp.width / vp.width;
            const sy = baseVp.height / vp.height;
            const words: WordBox[] = rawWords
              .map((wd) => {
                const text = canonicalWord(wd.text);
                if (!text || wd.bbox.x1 <= wd.bbox.x0 || wd.bbox.y1 <= wd.bbox.y0) return null;
                return clipWordBox(
                  {
                    text,
                    x: wd.bbox.x0 * sx,
                    y: wd.bbox.y0 * sy,
                    width: (wd.bbox.x1 - wd.bbox.x0) * sx,
                    height: (wd.bbox.y1 - wd.bbox.y0) * sy,
                    confidence: wd.confidence,
                    source: "ocr",
                  },
                  baseVp.width,
                  baseVp.height,
                );
              })
              .filter((wd): wd is WordBox => Boolean(wd));
            newPages[i - 1] = {
              pageNumber: i,
              width: baseVp.width,
              height: baseVp.height,
              words,
            };
            done++;
            setOcrProgress(Math.round((done / total) * 100));
          }
        };
        await Promise.all(workers.map((_, idx) => runWorker(idx)));
        await Promise.all(workers.map((w) => w.terminate()));
      }

      setPages(newPages);
      const totalWords = newPages.reduce((acc, p) => acc + p.words.length, 0);
      const matchCount = newPages.reduce(
        (acc, p) => acc + p.words.filter((w) => isMatch(w.text)).length,
        0,
      );
      toast.success(
        `OCR concluído: ${totalWords} palavras detectadas, ${matchCount} marcação${matchCount === 1 ? "" : "ões"}.`,
      );
    } catch (err) {
      console.error(err);
      toast.error("Falha ao executar OCR.");
    } finally {
      setIsOcrRunning(false);
    }
  };

  // ---------- Search Terms ----------
  const addTerm = () => {
    const t = canonicalWord(termInput);
    if (!t) return;
    if (terms.includes(t)) {
      toast.info("Palavra já está na lista.");
      return;
    }
    setTerms((prev) => [...prev, t]);
    setTermInput("");
  };

  const removeTerm = (t: string) => {
    setTerms((prev) => prev.filter((x) => x !== t));
    if (activeTerm === t) setActiveTerm(null);
  };

  // ---------- Occurrences ----------
  const matchedSet = useMemo(() => new Set(terms.map(canonicalWord).filter(Boolean)), [terms]);

  const isMatch = useCallback(
    (text: string, only?: string | null) => {
      const word = canonicalWord(text);
      if (!word) return false;
      if (only) {
        const term = canonicalWord(only);
        return term.length > 0 && word === term;
      }
      return matchedSet.has(word);
    },
    [matchedSet],
  );

  const occurrences = useMemo<Occurrence[]>(() => {
    if (!activeTerm) return [];
    const list: Occurrence[] = [];
    pages.forEach((p, pi) => {
      p.words.forEach((w, wi) => {
        if (isMatch(w.text, activeTerm)) list.push({ pageIndex: pi, wordIndex: wi });
      });
    });
    return list;
  }, [activeTerm, pages, isMatch]);

  const totalHighlights = useMemo(() => {
    let n = 0;
    pages.forEach((p) => p.words.forEach((w) => isMatch(w.text) && n++));
    return n;
  }, [pages, isMatch]);

  const goToOccurrence = useCallback(
    (idx: number) => {
      if (occurrences.length === 0) return;
      const safe = ((idx % occurrences.length) + occurrences.length) % occurrences.length;
      setActiveOccurrenceIdx(safe);
      const occ = occurrences[safe];
      const el = pageRefs.current.get(occ.pageIndex + 1);
      if (!el) return;
      const page = pages[occ.pageIndex];
      const word = page.words[occ.wordIndex];
      const yPx = word.y * zoom;
      const viewer = viewerRef.current;
      if (viewer) {
        const top = el.offsetTop + yPx - 100;
        viewer.scrollTo({ top, behavior: "smooth" });
      }
    },
    [occurrences, pages, zoom],
  );

  useEffect(() => {
    setActiveOccurrenceIdx(0);
  }, [activeTerm]);

  // ---------- Export ----------
  const exportPdf = async () => {
    if (!file || pages.length === 0) {
      toast.error("Carregue um PDF e rode o OCR primeiro.");
      return;
    }
    setIsExporting(true);
    try {
      const { PDFDocument, rgb } = await import("pdf-lib");
      const buf = await file.arrayBuffer();
      const pdf = await PDFDocument.load(buf);
      const pdfPages = pdf.getPages();
      pages.forEach((p, i) => {
        const page = pdfPages[i];
        if (!page) return;
        const { height: pageHeight } = page.getSize();
        p.words.forEach((w) => {
          if (!isMatch(w.text)) return;
          // pdf-lib origin is bottom-left; our boxes are top-left in PDF points
          page.drawRectangle({
            x: w.x,
            y: pageHeight - w.y - w.height,
            width: w.width,
            height: w.height,
            color: rgb(1, 0.92, 0.23),
            opacity: 0.4,
          });
        });
      });
      const bytes = await pdf.save();
      // Copy into a fresh ArrayBuffer to satisfy BlobPart typing
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      const blob = new Blob([ab], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (file.name.replace(/\.pdf$/i, "") || "documento") + "-marcado.pdf";
      a.click();
      URL.revokeObjectURL(url);
      toast.success("PDF marcado gerado com sucesso.");
    } catch (err) {
      console.error(err);
      toast.error("Falha ao gerar PDF marcado.");
    } finally {
      setIsExporting(false);
    }
  };

  // ---------- Render ----------
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-4 shadow-[var(--shadow-soft)]">
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg text-primary-foreground"
            style={{ background: "var(--gradient-primary)" }}
          >
            <ScanText className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">PDF Reader OCR Inteligente</h1>
            <p className="text-xs text-muted-foreground">
              Upload, OCR, busca e marcação automática de palavras
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {file && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText className="h-4 w-4" />
              <span className="max-w-[280px] truncate">{file.name}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Sun className="h-4 w-4 text-muted-foreground" />
            <Switch checked={isDark} onCheckedChange={toggleTheme} aria-label="Alternar tema" />
            <Moon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: PDF Preview (70%) */}
        <main className="relative flex-1 overflow-hidden bg-muted">
          {!file ? (
            <div className="flex h-full items-center justify-center p-8">
              <label
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                className="group flex w-full max-w-xl cursor-pointer flex-col items-center gap-4 rounded-xl border-2 border-dashed border-border bg-card px-8 py-16 text-center transition-all hover:border-primary hover:shadow-[var(--shadow-elegant)]"
              >
                <div
                  className="flex h-16 w-16 items-center justify-center rounded-full text-primary-foreground transition-transform group-hover:scale-110"
                  style={{ background: "var(--gradient-primary)" }}
                >
                  <Upload className="h-7 w-7" />
                </div>
                <div>
                  <h2 className="text-xl font-semibold">Envie seu PDF</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Arraste um arquivo aqui ou clique para selecionar
                  </p>
                </div>
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={onFileInput}
                />
              </label>
            </div>
          ) : (
            <>
              {/* Zoom controls */}
              <div className="absolute right-4 top-4 z-20 flex items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-[var(--shadow-soft)]">
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}
                >
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="min-w-[3rem] text-center text-xs tabular-nums">
                  {Math.round(zoom * 100)}%
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => setZoom((z) => Math.min(3, z + 0.1))}
                >
                  <ZoomIn className="h-4 w-4" />
                </Button>
              </div>

              <div ref={viewerRef} className="h-full overflow-auto">
                <div className="flex flex-col items-center gap-6 p-6">
                  {pages.map((p, pi) => {
                    const scale = zoom;
                    return (
                      <div
                        key={p.pageNumber}
                        ref={(el) => {
                          if (el) pageRefs.current.set(p.pageNumber, el);
                        }}
                        className="relative rounded-md bg-card shadow-[var(--shadow-soft)] ring-1 ring-border"
                        style={{
                          width: Math.floor(p.width * scale),
                          height: Math.floor(p.height * scale),
                        }}
                      >
                        <canvas className="block rounded-md" />
                        <div
                          data-pdf-text-layer="true"
                          className="pdf-text-layer absolute inset-0 rounded-md"
                          style={{ display: "none" }}
                        />
                        {/* Highlight overlay */}
                        <div className="pointer-events-none absolute inset-0">
                          {p.words.map((w, wi) => {
                            if (!isMatch(w.text)) return null;
                            const isActive =
                              activeTerm &&
                              isMatch(w.text, activeTerm) &&
                              occurrences[activeOccurrenceIdx]?.pageIndex === pi &&
                              occurrences[activeOccurrenceIdx]?.wordIndex === wi;
                            return (
                              <div
                                key={wi}
                                title={w.text}
                                className="pointer-events-auto absolute rounded-sm transition-colors"
                                style={{
                                  left: Math.round(w.x * scale),
                                  top: Math.round(w.y * scale),
                                  width: Math.round(w.width * scale),
                                  height: Math.round(w.height * scale),
                                  backgroundColor: isActive
                                    ? "color-mix(in oklab, var(--highlight-active) 55%, transparent)"
                                    : "color-mix(in oklab, var(--highlight) 50%, transparent)",
                                  outline: isActive ? "2px solid var(--highlight-active)" : "none",
                                }}
                              />
                            );
                          })}
                        </div>
                        <div className="absolute -top-3 left-3 rounded-full bg-card px-2 py-0.5 text-[10px] font-medium text-muted-foreground ring-1 ring-border">
                          Página {p.pageNumber}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Busy overlay */}
          {isBusy && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-background/70 backdrop-blur-sm">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="mt-4 font-medium">
                {isLoadingPdf ? "Carregando PDF…" : "Aplicando OCR…"}
              </p>
              {isOcrRunning && <p className="text-sm text-muted-foreground">{ocrProgress}%</p>}
            </div>
          )}
        </main>

        {/* Right: Control Panel (30%) */}
        <aside className="flex w-[380px] flex-col border-l border-border bg-card">
          <div className="border-b border-border p-4">
            <h2 className="text-sm font-semibold">Painel de Controle</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {pages.length > 0
                ? `${pages.length} página${pages.length > 1 ? "s" : ""} • ${totalHighlights} marcação${totalHighlights === 1 ? "" : "ões"}`
                : "Nenhum PDF carregado"}
            </p>
          </div>

          <div className="space-y-4 p-4">
            <div className="grid grid-cols-2 gap-2">
              <label className="contents">
                <input
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={onFileInput}
                  disabled={isBusy}
                />
                <Button variant="outline" className="w-full" asChild disabled={isBusy}>
                  <span>
                    <Upload className="mr-2 h-4 w-4" />
                    Trocar PDF
                  </span>
                </Button>
              </label>
              <Button onClick={runOcr} disabled={!pdfDoc || isBusy}>
                {isBusy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ScanText className="mr-2 h-4 w-4" />
                )}
                Aplicar OCR
              </Button>
            </div>

            <Button
              onClick={async () => {
                if (terms.length === 0) {
                  toast.error("Adicione pelo menos uma palavra-chave.");
                  return;
                }
                setActiveTerm(null);
                if (pages.every((p) => p.words.length === 0)) {
                  await runOcr();
                } else {
                  toast.success(
                    `${totalHighlights} marcação${totalHighlights === 1 ? "" : "ões"} aplicada${totalHighlights === 1 ? "" : "s"}.`,
                  );
                }
              }}
              disabled={!pdfDoc || isBusy || terms.length === 0}
              className="w-full"
              variant="secondary"
            >
              <Highlighter className="mr-2 h-4 w-4" />
              Marcar palavras no PDF
            </Button>

            <Button
              onClick={exportPdf}
              disabled={
                !pdfDoc || pages.every((p) => p.words.length === 0) || isExporting || isBusy
              }
              className="w-full"
              style={{ background: "var(--gradient-primary)" }}
            >
              {isExporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Download className="mr-2 h-4 w-4" />
              )}
              Baixar PDF marcado
            </Button>
          </div>

          <Separator />

          <div className="p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Search className="h-4 w-4" />
              Banco de palavras
            </h3>
            <div className="flex gap-2">
              <Input
                placeholder="ex: contrato"
                value={termInput}
                onChange={(e) => setTermInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !isBusy && addTerm()}
                disabled={isBusy}
              />
              <Button size="icon" onClick={addTerm} disabled={isBusy}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {terms.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Adicione palavras-chave para destacar.
                </p>
              )}
              {terms.map((t) => {
                const count = pages.reduce(
                  (acc, p) => acc + p.words.filter((w) => isMatch(w.text, t)).length,
                  0,
                );
                const isActive = activeTerm === t;
                return (
                  <Badge
                    key={t}
                    variant={isActive ? "default" : "secondary"}
                    className={`gap-1.5 px-2.5 py-1 text-xs ${isBusy ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}
                    onClick={() => !isBusy && setActiveTerm(isActive ? null : t)}
                  >
                    <span>{t}</span>
                    <span className="rounded-full bg-background/30 px-1.5 text-[10px] tabular-nums">
                      {count}
                    </span>
                    <button
                      disabled={isBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (isBusy) return;
                        removeTerm(t);
                      }}
                      className="ml-1 opacity-60 hover:opacity-100 disabled:cursor-not-allowed"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
          </div>

          <Separator />

          {/* Occurrences */}
          <div className="flex flex-1 flex-col overflow-hidden p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Ocorrências
                {activeTerm && <span className="ml-1 text-muted-foreground">· "{activeTerm}"</span>}
              </h3>
              {activeTerm && occurrences.length > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {activeOccurrenceIdx + 1}/{occurrences.length}
                </span>
              )}
            </div>

            <div className="mb-3 flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={!activeTerm || occurrences.length === 0 || isBusy}
                onClick={() => goToOccurrence(activeOccurrenceIdx - 1)}
              >
                <ChevronUp className="mr-1 h-4 w-4" />
                Anterior
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                disabled={!activeTerm || occurrences.length === 0 || isBusy}
                onClick={() => goToOccurrence(activeOccurrenceIdx + 1)}
              >
                Próxima
                <ChevronDown className="ml-1 h-4 w-4" />
              </Button>
            </div>

            <ScrollArea className="flex-1 rounded-md border border-border">
              {!activeTerm ? (
                <p className="p-4 text-xs text-muted-foreground">
                  Selecione uma palavra acima para listar e navegar pelas ocorrências.
                </p>
              ) : occurrences.length === 0 ? (
                <p className="p-4 text-xs text-muted-foreground">
                  Nenhuma ocorrência encontrada. Rode o OCR ou adicione um termo válido.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {occurrences.map((o, i) => {
                    const w = pages[o.pageIndex].words[o.wordIndex];
                    const isCurrent = i === activeOccurrenceIdx;
                    return (
                      <li key={i}>
                        <button
                          onClick={() => goToOccurrence(i)}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-muted ${
                            isCurrent ? "bg-muted font-medium" : ""
                          }`}
                        >
                          <span className="truncate">{w.text}</span>
                          <span className="ml-2 shrink-0 text-muted-foreground">
                            p.{o.pageIndex + 1}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ScrollArea>
          </div>
        </aside>
      </div>
    </div>
  );
}
