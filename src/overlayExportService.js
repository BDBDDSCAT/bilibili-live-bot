"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright-core");
const { PNG } = require("pngjs");

const OUTPUT_FILES = {
  png: "gift-static-latest.png",
  gif: "gift-scroll-latest.gif",
  webm: "gift-scroll-latest.webm",
};

const OUTPUT_LABELS = {
  png: "透明 PNG",
  gif: "透明 GIF",
  webm: "透明 WebM（OBS 高质量备用）",
};

// 视口尺寸必须与 public/gifts-overlay.css 手工同步：
// static = .static-overlay（min-height 154 + margin 12*2 = 178）
// scroll = .scroll-overlay（height 92 + margin 10*2 = 112）
// 改 CSS 高度时这里要跟着改，否则导出的 PNG/GIF 会被裁切
const VIEWPORTS = {
  static: { width: 960, height: 180 },
  scroll: { width: 1280, height: 112 },
};

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function isLoopbackUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    // WHATWG URL 对 IPv6 hostname 返回带方括号的 "[::1]"
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function commandOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
    let timedOut = false;
    let killTimer = null;
    let forceKillTimer = null;
    if (timeoutMs > 0) {
      // 超时立刻向调用方报错并发 SIGTERM，3 秒仍不退出再 SIGKILL；
      // 不等 close 事件，避免子进程的孙进程占着 stdio 管道让调用方一直挂着
      killTimer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`${command} 执行超时（超过 ${Math.round(timeoutMs / 1000)} 秒），已强制终止`));
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        if (typeof forceKillTimer.unref === "function") forceKillTimer.unref();
      }, timeoutMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
    }
    const clearTimers = () => {
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimers();
      if (timedOut) return;
      const result = {
        code: Number(code),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else {
        const detail = result.stderr.trim().split("\n").slice(-8).join("\n");
        reject(new Error(`${command} 执行失败 (${code})${detail ? `\n${detail}` : ""}`));
      }
    });
  });
}

function resolveChromeExecutable(preferred = "") {
  const candidates = [
    preferred,
    typeof chromium.executablePath === "function" ? chromium.executablePath() : "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function inspectPngAlpha(filePath) {
  const image = PNG.sync.read(fs.readFileSync(filePath));
  let transparentPixels = 0;
  let partialAlphaPixels = 0;
  let visiblePixels = 0;
  for (let index = 3; index < image.data.length; index += 4) {
    const alpha = image.data[index];
    if (alpha === 0) transparentPixels += 1;
    else {
      visiblePixels += 1;
      if (alpha < 255) partialAlphaPixels += 1;
    }
  }
  if (!transparentPixels || !visiblePixels) {
    throw new Error(`PNG alpha 验证失败：transparent=${transparentPixels}, visible=${visiblePixels}`);
  }
  return {
    width: image.width,
    height: image.height,
    transparentPixels,
    partialAlphaPixels,
    visiblePixels,
  };
}

// 启发式初筛：朴素字节扫描，LZW 图像数据里偶然出现 21 F9 04 会被误判为图形控制扩展块，
// 单独使用不可靠，结论必须以 ffmpeg 解码首帧后 inspectPngAlpha 的结果为准
function inspectGifTransparency(filePath) {
  const buffer = fs.readFileSync(filePath);
  let transparentControlBlocks = 0;
  const transparentIndexes = new Set();
  for (let index = 0; index <= buffer.length - 8; index += 1) {
    if (
      buffer[index] === 0x21 &&
      buffer[index + 1] === 0xf9 &&
      buffer[index + 2] === 0x04
    ) {
      const packed = buffer[index + 3];
      if (packed & 0x01) {
        transparentControlBlocks += 1;
        transparentIndexes.add(buffer[index + 6]);
      }
    }
  }
  if (!transparentControlBlocks) throw new Error("GIF 没有透明索引控制块");
  return {
    transparentControlBlocks,
    transparentIndexes: [...transparentIndexes],
    bytes: buffer.length,
  };
}

async function probeWebmAlpha(filePath, ffprobePath = "ffprobe", options = {}) {
  const result = await commandOutput(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,pix_fmt,width,height:stream_tags=alpha_mode",
      "-of",
      "json",
      filePath,
    ],
    { timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000 }
  );
  const payload = JSON.parse(result.stdout || "{}");
  const stream = payload.streams?.[0] || {};
  const alphaMode = String(stream.tags?.alpha_mode || stream.tags?.ALPHA_MODE || "");
  if (stream.codec_name !== "vp9" || alphaMode !== "1") {
    throw new Error(
      `WebM alpha 验证失败：codec=${stream.codec_name || "unknown"}, alpha_mode=${alphaMode || "none"}`
    );
  }
  return {
    codec: stream.codec_name,
    pixelFormat: stream.pix_fmt || "",
    alphaMode,
    width: Number(stream.width || 0),
    height: Number(stream.height || 0),
  };
}

class OverlayExportService {
  constructor(options = {}) {
    this.rootDir = path.resolve(options.rootDir || path.resolve(__dirname, ".."));
    this.outputDir = path.resolve(options.outputDir || path.join(this.rootDir, "state", "overlays"));
    this.ffmpegPath = String(options.ffmpegPath || "ffmpeg");
    this.ffprobePath = String(options.ffprobePath || "ffprobe");
    this.preferredChromeExecutable = String(options.chromeExecutable || "");
    this.chromeExecutable = resolveChromeExecutable(this.preferredChromeExecutable);
    this.fps = Math.round(clamp(options.fps, 5, 15, 10));
    this.durationSec = clamp(options.durationSec, 3, 10, 6);
    // 任务级总超时：整条『起 Chrome→截帧→ffmpeg 双编码』的看门狗，超时强制收尾解锁
    this.jobTimeoutMs = Math.round(clamp(options.jobTimeoutMs, 60000, 1800000, 300000));
    // 单次 ffmpeg/ffprobe 子进程超时
    this.commandTimeoutMs = Math.round(clamp(options.commandTimeoutMs, 10000, 600000, 120000));
    // 页面内图片等待上限，超时不算失败、按已加载内容继续截图
    this.imageWaitMs = Math.round(clamp(options.imageWaitMs, 1000, 60000, 10000));
    this.inFlight = null;
    this.currentJob = null;
    this.activeBrowser = null;
    this.lastResult = null;
    this.lastError = "";
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.cleanupStaleJobDirs();
    this.restoreLastResult();
  }

  // 清扫进程异常退出后残留的 .job-* 帧目录，避免长期部署下持续堆积
  cleanupStaleJobDirs() {
    let entries = [];
    try {
      entries = fs.readdirSync(this.outputDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".job-")) continue;
      try {
        fs.rmSync(path.join(this.outputDir, entry.name), { recursive: true, force: true });
      } catch {
        // 清不掉就留给下次，别影响正常生成
      }
    }
  }

  // 启动时从 manifest.json 恢复上一次生成结果，供 /api/overlays 状态展示
  restoreLastResult() {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(this.outputDir, "manifest.json"), "utf8")
      );
      if (parsed && parsed.ok === true && Array.isArray(parsed.artifacts)) {
        this.lastResult = parsed;
      }
    } catch {
      // 没有 manifest 或内容损坏都按无历史处理
    }
  }

  getState() {
    return {
      busy: Boolean(this.inFlight),
      currentJob: this.currentJob,
      lastError: this.lastError,
      lastResult: this.lastResult,
      outputDir: this.outputDir,
      artifacts: this.listArtifacts(),
    };
  }

  publicArtifact(filePath, validation = null) {
    const stat = fs.statSync(filePath);
    const format = path.extname(filePath).slice(1).toLowerCase();
    return {
      format,
      label: OUTPUT_LABELS[format] || format.toUpperCase(),
      filename: path.basename(filePath),
      filePath,
      downloadUrl: `/api/overlays/files/${encodeURIComponent(path.basename(filePath))}`,
      bytes: stat.size,
      updatedAt: stat.mtimeMs,
      validation,
    };
  }

  listArtifacts() {
    return Object.values(OUTPUT_FILES)
      .map((filename) => path.join(this.outputDir, filename))
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => this.publicArtifact(filePath));
  }

  resolveArtifact(filename = "") {
    let decoded = "";
    try {
      decoded = decodeURIComponent(String(filename || ""));
    } catch {
      // 畸形百分号序列按不存在处理，走 404
      return "";
    }
    if (!decoded || path.basename(decoded) !== decoded) return "";
    if (!Object.values(OUTPUT_FILES).includes(decoded)) return "";
    const filePath = path.resolve(this.outputDir, decoded);
    return filePath.startsWith(`${this.outputDir}${path.sep}`) && fs.existsSync(filePath)
      ? filePath
      : "";
  }

  async generate(options = {}) {
    if (this.inFlight) {
      const error = new Error("已在生成素材，请等当前任务完成");
      error.statusCode = 409;
      throw error;
    }
    const format = ["png", "gif", "webm", "bundle"].includes(String(options.format || ""))
      ? String(options.format)
      : "gif";
    const mode = options.mode === "static" ? "static" : "scroll";
    const includeWebm = options.includeWebm !== false;
    const baseUrl = String(options.baseUrl || "").replace(/\/$/, "");
    if (!isLoopbackUrl(baseUrl)) {
      const error = new Error("素材生成只允许读取本机直播助理页面");
      error.statusCode = 400;
      throw error;
    }

    this.currentJob = { format, mode, startedAt: Date.now() };
    this.lastError = "";
    this.inFlight = this.runGenerationWithWatchdog({ format, mode, includeWebm, baseUrl })
      .then((result) => {
        this.lastResult = result;
        return result;
      })
      .catch((error) => {
        this.lastError = error.message || String(error);
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
        this.currentJob = null;
      });
    return this.inFlight;
  }

  // 看门狗：任务超过 jobTimeoutMs 一律判死，强制关浏览器让挂起的 playwright 调用出错收尾，
  // 保证 generate 的 finally 一定能清掉 inFlight，避免 409 死锁只能靠重启进程
  async runGenerationWithWatchdog(job) {
    let watchdog = null;
    const timeoutPromise = new Promise((resolve, reject) => {
      watchdog = setTimeout(() => {
        const error = new Error(
          `素材生成超时（超过 ${Math.round(this.jobTimeoutMs / 1000)} 秒），已强制终止，请重试`
        );
        error.statusCode = 504;
        this.activeBrowser?.close().catch(() => {});
        reject(error);
      }, this.jobTimeoutMs);
      if (typeof watchdog.unref === "function") watchdog.unref();
    });
    try {
      return await Promise.race([this.runGeneration(job), timeoutPromise]);
    } finally {
      clearTimeout(watchdog);
    }
  }

  async runGeneration({ format, mode, includeWebm, baseUrl }) {
    this.cleanupStaleJobDirs();
    const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const tempDir = path.join(this.outputDir, `.job-${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    let browser = null;
    try {
      // 每次生成重新解析 Chrome 路径，长期驻留进程期间更新/重装 Chrome 不用重启
      this.chromeExecutable = resolveChromeExecutable(this.preferredChromeExecutable);
      const launchOptions = {
        headless: true,
        args: ["--hide-scrollbars", "--disable-dev-shm-usage"],
      };
      if (this.chromeExecutable) launchOptions.executablePath = this.chromeExecutable;
      else launchOptions.channel = "chrome";
      browser = await chromium.launch(launchOptions);
      this.activeBrowser = browser;

      const artifacts = [];
      if (format === "png" || format === "bundle") {
        const tempPng = path.join(tempDir, OUTPUT_FILES.png);
        await this.capturePng(
          browser,
          baseUrl,
          tempPng,
          format === "bundle" ? "static" : mode === "scroll" ? "scroll" : "static"
        );
        const validation = inspectPngAlpha(tempPng);
        const finalPath = path.join(this.outputDir, OUTPUT_FILES.png);
        fs.renameSync(tempPng, finalPath);
        artifacts.push(this.publicArtifact(finalPath, { alpha: true, ...validation }));
      }

      if (format === "gif" || format === "webm" || format === "bundle") {
        const framesDir = path.join(tempDir, "frames");
        fs.mkdirSync(framesDir, { recursive: true });
        await this.captureScrollFrames(browser, baseUrl, framesDir);
        if (format === "gif" || format === "bundle") {
          const tempGif = path.join(tempDir, OUTPUT_FILES.gif);
          await this.encodeGif(framesDir, tempGif);
          const validation = inspectGifTransparency(tempGif);
          const decodedGifFrame = path.join(tempDir, "gif-alpha-check.png");
          await commandOutput(
            this.ffmpegPath,
            ["-y", "-i", tempGif, "-frames:v", "1", decodedGifFrame],
            { timeoutMs: this.commandTimeoutMs }
          );
          const decodedAlpha = inspectPngAlpha(decodedGifFrame);
          const finalPath = path.join(this.outputDir, OUTPUT_FILES.gif);
          fs.renameSync(tempGif, finalPath);
          artifacts.push(
            this.publicArtifact(finalPath, {
              alpha: true,
              transparentIndex: true,
              ...validation,
              decodedAlpha,
            })
          );
        }

        if (format === "webm" || format === "bundle" || (format === "gif" && includeWebm)) {
          const tempWebm = path.join(tempDir, OUTPUT_FILES.webm);
          await this.encodeWebm(framesDir, tempWebm);
          const validation = await probeWebmAlpha(tempWebm, this.ffprobePath, {
            timeoutMs: this.commandTimeoutMs,
          });
          const decodedWebmFrame = path.join(tempDir, "webm-alpha-check.png");
          await commandOutput(
            this.ffmpegPath,
            ["-y", "-c:v", "libvpx-vp9", "-i", tempWebm, "-frames:v", "1", decodedWebmFrame],
            { timeoutMs: this.commandTimeoutMs }
          );
          const decodedAlpha = inspectPngAlpha(decodedWebmFrame);
          const finalPath = path.join(this.outputDir, OUTPUT_FILES.webm);
          fs.renameSync(tempWebm, finalPath);
          artifacts.push(this.publicArtifact(finalPath, { alpha: true, ...validation, decodedAlpha }));
        }
      }

      const result = {
        ok: true,
        generatedAt: Date.now(),
        outputDir: this.outputDir,
        artifacts,
      };
      this.writeManifest(result);
      return result;
    } finally {
      if (this.activeBrowser === browser) this.activeBrowser = null;
      await browser?.close().catch(() => {});
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // 删不掉的残留交给下次 cleanupStaleJobDirs
      }
    }
  }

  async openOverlayPage(browser, baseUrl, mode) {
    const viewport = VIEWPORTS[mode];
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    const page = await context.newPage();
    const pathname = mode === "scroll" ? "/gifts-scroll.html" : "/gifts-static.html";
    const pageUrl = `${baseUrl}${pathname}?export=1&exportDuration=${this.durationSec}`;
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
    try {
      await page.waitForFunction(() => window.__giftOverlayExportReady === true, null, {
        timeout: 15000,
      });
    } catch {
      // 把页面里记录的失败原因翻译成可读错误，别让用户只看到 playwright 超时
      const detail = await page
        .evaluate(() => String(window.__giftOverlayExportError || ""))
        .catch(() => "");
      throw new Error(
        detail ? `叠加层页面未就绪：${detail}` : "叠加层页面未就绪：等待状态同步超时"
      );
    }
    await page.evaluate(async (imageWaitMs) => {
      if (document.fonts?.ready) await document.fonts.ready;
      // 图片等待带上限：某张图网络挂起时按已加载内容继续，不让整个任务卡死
      const imagesReady = Promise.all(
        [...document.images].map((image) =>
          image.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
                image.addEventListener("load", resolve, { once: true });
                image.addEventListener("error", resolve, { once: true });
              })
        )
      );
      await Promise.race([
        imagesReady,
        new Promise((resolve) => setTimeout(resolve, imageWaitMs)),
      ]);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, this.imageWaitMs);
    return { context, page, viewport };
  }

  async capturePng(browser, baseUrl, outputPath, mode = "static") {
    const { context, page } = await this.openOverlayPage(browser, baseUrl, mode);
    try {
      await page.screenshot({ path: outputPath, type: "png", omitBackground: true });
    } finally {
      await context.close();
    }
  }

  async captureScrollFrames(browser, baseUrl, framesDir) {
    const { context, page } = await this.openOverlayPage(browser, baseUrl, "scroll");
    const frameCount = Math.max(1, Math.round(this.durationSec * this.fps));
    try {
      await page.evaluate(() => {
        const animation = document.querySelector("#giftTrack")?.getAnimations?.()[0];
        if (animation) animation.pause();
      });
      for (let index = 0; index < frameCount; index += 1) {
        const currentTimeMs = (index / frameCount) * this.durationSec * 1000;
        await page.evaluate(async (time) => {
          const animation = document.querySelector("#giftTrack")?.getAnimations?.()[0];
          if (animation) {
            animation.pause();
            animation.currentTime = time;
          }
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }, currentTimeMs);
        const filename = `frame-${String(index).padStart(4, "0")}.png`;
        await page.screenshot({
          path: path.join(framesDir, filename),
          type: "png",
          omitBackground: true,
        });
      }
    } finally {
      await context.close();
    }
    return frameCount;
  }

  async encodeGif(framesDir, outputPath) {
    const inputPattern = path.join(framesDir, "frame-%04d.png");
    const filter = [
      "[0:v]split[frames][palette_source]",
      "[palette_source]palettegen=reserve_transparent=1:transparency_color=ffffff[palette]",
      "[frames][palette]paletteuse=alpha_threshold=128:dither=sierra2_4a[out]",
    ].join(";");
    await commandOutput(this.ffmpegPath, [
      "-y",
      "-framerate",
      String(this.fps),
      "-i",
      inputPattern,
      "-filter_complex",
      filter,
      "-map",
      "[out]",
      "-loop",
      "0",
      outputPath,
    ]);
  }

  async encodeWebm(framesDir, outputPath) {
    const inputPattern = path.join(framesDir, "frame-%04d.png");
    await commandOutput(this.ffmpegPath, [
      "-y",
      "-framerate",
      String(this.fps),
      "-i",
      inputPattern,
      "-an",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-auto-alt-ref",
      "0",
      "-b:v",
      "0",
      "-crf",
      "30",
      "-metadata:s:v:0",
      "alpha_mode=1",
      outputPath,
    ]);
  }

  writeManifest(result) {
    const finalPath = path.join(this.outputDir, "manifest.json");
    const tempPath = `${finalPath}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, finalPath);
  }
}

module.exports = OverlayExportService;
module.exports.OverlayExportService = OverlayExportService;
module.exports.OUTPUT_FILES = OUTPUT_FILES;
module.exports.inspectPngAlpha = inspectPngAlpha;
module.exports.inspectGifTransparency = inspectGifTransparency;
module.exports.probeWebmAlpha = probeWebmAlpha;
module.exports.resolveChromeExecutable = resolveChromeExecutable;
