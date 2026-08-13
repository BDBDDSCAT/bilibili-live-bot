"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { deepMerge, loadConfig } = require("../src/configLoader");
const { createWebApp } = require("../src/webServer");

class PassiveBrowserController extends EventEmitter {
  getState() {
    return {
      status: "idle",
      running: false,
      ready: false,
      loggedIn: false,
      roomId: 1985118453,
      roomUrl: "https://live.bilibili.com/1985118453",
      emergencyStopped: false,
    };
  }

  async stop() {}
  async emergencyStop() {}
}

class ReconfigurableLocalAiService {
  constructor(initialConfig = {}) {
    this.config = structuredClone(initialConfig);
    this.reconfigureCalls = [];
    this.ensureReadyCalls = 0;
    this.state = this.stateForConfig(this.config);
  }

  stateForConfig(config = this.config) {
    return {
      status: config.enabled ? "idle" : "skipped",
      message: config.enabled ? "waiting for isolated test probe" : "disabled in isolated test",
      model: String(config.model || ""),
      lastCheckedAt: 0,
    };
  }

  getState() {
    return { ...this.state };
  }

  reconfigure(nextConfig = {}) {
    this.config = structuredClone(nextConfig);
    this.reconfigureCalls.push(structuredClone(nextConfig));
    this.state = this.stateForConfig(this.config);
    return this.getState();
  }

  async ensureReady() {
    this.ensureReadyCalls += 1;
    this.state = {
      status: this.config.enabled ? "ready" : "skipped",
      message: this.config.enabled ? "isolated test model ready" : "disabled in isolated test",
      model: String(this.config.model || ""),
      lastCheckedAt: this.ensureReadyCalls,
    };
    return this.getState();
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function baseUserConfig() {
  return {
    room: "https://live.bilibili.com/1985118453",
    dryRun: true,
    connection: { autoStartSafe: false },
    history: { dir: "state" },
    automation: { enabled: false },
    browserAutomation: {
      enabled: false,
      roomUrl: "https://live.bilibili.com/1985118453",
      autoLike: { enabled: false },
    },
    modules: {
      autoSend: { enabled: false },
      autoLike: { enabled: false },
      welcome: { enabled: false },
      giftThanks: { enabled: false },
      guardBoard: { enabled: false },
      ai: { enabled: false },
      rotation: { enabled: false },
    },
    interactions: {
      welcome: { enabled: false },
      gift: { enabled: false },
      superChat: { enabled: false },
      guard: { enabled: false },
    },
    localAi: {
      enabled: false,
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen3.5:4b",
      autoStart: false,
      proactive: { enabled: false },
    },
  };
}

async function createFixture(overrides = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bilibot-feature-api-"));
  const configPath = path.join(rootDir, "config.json");
  const userConfig = deepMerge(baseUserConfig(), overrides);
  fs.writeFileSync(configPath, `${JSON.stringify(userConfig, null, 2)}\n`, "utf8");

  const config = loadConfig({ configPath, rootDir });
  const localAiService = new ReconfigurableLocalAiService(config.localAi);
  const app = createWebApp({
    rootDir,
    config,
    browserController: new PassiveBrowserController(),
    localAiService,
  });
  const server = http.createServer(app.handleRequest);
  await listen(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    rootDir,
    configPath,
    config,
    localAiService,
    async getState() {
      const response = await fetch(`${baseUrl}/api/state`);
      assert.equal(response.status, 200);
      return response.json();
    },
    async postFeature(name, enabled) {
      const response = await fetch(`${baseUrl}/api/features`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, enabled }),
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text };
      }
      return { response, payload };
    },
    async cleanup() {
      await app.stop();
      await close(server);
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function readSavedConfig(fixture) {
  return JSON.parse(fs.readFileSync(fixture.configPath, "utf8"));
}

function assertNoTempConfig(fixture) {
  assert.equal(
    fs.readdirSync(fixture.rootDir).some((name) => name.startsWith("config.json.tmp-")),
    false,
    "atomic rename must not leave a temporary config behind"
  );
}

function assertFeatureStatus(payload, name, enabled, previousRevision) {
  const featureStatus = payload?.snapshot?.featureStatus;
  assert.ok(featureStatus && typeof featureStatus === "object", "response must expose snapshot.featureStatus");
  assert.ok(Number.isInteger(featureStatus.revision), "featureStatus.revision must be an integer");
  assert.ok(
    featureStatus.revision > previousRevision,
    `successful ${name} update must advance featureStatus.revision`
  );
  const feature = featureStatus[name];
  assert.ok(feature && typeof feature === "object", `featureStatus.${name} must be an object`);
  assert.equal(feature.enabled, enabled);
  assert.equal(typeof feature.effective, "boolean");
  assert.ok(Array.isArray(feature.blockers));
  return featureStatus.revision;
}

function assertPersistedAndInMemory(fixture, assertion) {
  assertion(fixture.config);
  assertion(readSavedConfig(fixture));
  assertNoTempConfig(fixture);
}

test("feature API atomically expands simple UI switches into every required runtime gate", async () => {
  const fixture = await createFixture();
  try {
    const initialState = await fixture.getState();
    const initialStatus = initialState.snapshot.featureStatus;
    assert.ok(initialStatus && Number.isInteger(initialStatus.revision));
    for (const name of ["welcome", "giftThanks", "autoLike", "ai", "rotation"]) {
      assert.equal(initialStatus[name].enabled, false);
      assert.equal(typeof initialStatus[name].effective, "boolean");
      assert.ok(Array.isArray(initialStatus[name].blockers));
    }
    let revision = initialStatus.revision;

    let result = await fixture.postFeature("welcome", true);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "welcome", true, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.interactions.welcome.enabled, true);
      assert.equal(config.modules.welcome.enabled, true);
      assert.equal(config.automation.enabled, true);
    });

    result = await fixture.postFeature("giftThanks", true);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "giftThanks", true, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.interactions.gift.enabled, true);
      assert.equal(config.interactions.superChat.enabled, true);
      assert.equal(config.interactions.guard.enabled, true);
      assert.equal(config.modules.giftThanks.enabled, true);
      assert.equal(config.modules.guardBoard.enabled, true);
    });

    result = await fixture.postFeature("welcome", false);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "welcome", false, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.interactions.welcome.enabled, false);
      assert.equal(config.modules.welcome.enabled, false);
    });

    result = await fixture.postFeature("giftThanks", false);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "giftThanks", false, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.interactions.gift.enabled, false);
      assert.equal(config.interactions.superChat.enabled, false);
      assert.equal(config.interactions.guard.enabled, false);
      assert.equal(config.modules.giftThanks.enabled, false);
      assert.equal(config.modules.guardBoard.enabled, false);
    });

    result = await fixture.postFeature("autoLike", true);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "autoLike", true, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.modules.autoLike.enabled, true);
      assert.equal(config.browserAutomation.enabled, true);
      assert.equal(config.browserAutomation.autoLike.enabled, true);
    });

    result = await fixture.postFeature("ai", true);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "ai", true, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.modules.ai.enabled, true);
      assert.equal(config.localAi.enabled, true);
      assert.equal(config.automation.enabled, true);
    });
    assert.ok(fixture.localAiService.reconfigureCalls.length >= 1);
    assert.equal(fixture.localAiService.reconfigureCalls.at(-1).enabled, true);

    result = await fixture.postFeature("ai", false);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "ai", false, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.modules.ai.enabled, false);
      assert.equal(config.localAi.enabled, false);
      assert.equal(config.modules.rotation.enabled, false);
      assert.equal(config.localAi.proactive.enabled, false);
    });
    assert.equal(fixture.localAiService.reconfigureCalls.at(-1).enabled, false);

    result = await fixture.postFeature("rotation", true);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    revision = assertFeatureStatus(result.payload, "rotation", true, revision);
    assertPersistedAndInMemory(fixture, (config) => {
      assert.equal(config.modules.rotation.enabled, true);
      assert.equal(config.modules.ai.enabled, true);
      assert.equal(config.localAi.enabled, true);
      assert.equal(config.localAi.proactive.enabled, true);
      assert.equal(config.automation.enabled, true);
    });
    assert.equal(fixture.localAiService.reconfigureCalls.at(-1).enabled, true);
    assert.equal(fixture.localAiService.reconfigureCalls.at(-1).proactive.enabled, true);
    assert.ok(fixture.localAiService.ensureReadyCalls >= 2);

    const finalState = await fixture.getState();
    assert.equal(finalState.snapshot.featureStatus.revision, revision);
    assert.equal(finalState.snapshot.featureStatus.rotation.enabled, true);
  } finally {
    await fixture.cleanup();
  }
});

test("unknown feature is rejected without changing disk, memory, AI service, or revision", async () => {
  const fixture = await createFixture();
  try {
    const memoryBefore = structuredClone(fixture.config);
    const diskBefore = fs.readFileSync(fixture.configPath, "utf8");
    const stateBefore = await fixture.getState();

    const { response, payload } = await fixture.postFeature("not-a-real-feature", true);

    assert.equal(response.status, 400);
    assert.match(String(payload.error || ""), /feature|功能|开关|未知/i);
    assert.deepEqual(fixture.config, memoryBefore);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), diskBefore);
    assert.equal(fixture.localAiService.reconfigureCalls.length, 0);
    assert.equal(fixture.localAiService.ensureReadyCalls, 0);
    const stateAfter = await fixture.getState();
    assert.equal(
      stateAfter.snapshot.featureStatus.revision,
      stateBefore.snapshot.featureStatus.revision
    );
    assertNoTempConfig(fixture);
  } finally {
    await fixture.cleanup();
  }
});

test("validation failure is atomic and happens before local AI reconfiguration", async () => {
  // localAi.model may be empty while AI is disabled, but enabling AI must fail validation.
  const fixture = await createFixture({ localAi: { enabled: false, model: "" } });
  try {
    const memoryBefore = structuredClone(fixture.config);
    const diskBefore = fs.readFileSync(fixture.configPath, "utf8");
    const stateBefore = await fixture.getState();

    const { response, payload } = await fixture.postFeature("ai", true);

    assert.equal(response.status, 400);
    assert.match(String(payload.error || ""), /localAi\.model|模型|配置/i);
    assert.deepEqual(fixture.config, memoryBefore);
    assert.equal(fs.readFileSync(fixture.configPath, "utf8"), diskBefore);
    assert.equal(fixture.localAiService.reconfigureCalls.length, 0);
    assert.equal(fixture.localAiService.ensureReadyCalls, 0);
    const stateAfter = await fixture.getState();
    assert.equal(stateAfter.snapshot.featureStatus.ai.enabled, false);
    assert.equal(
      stateAfter.snapshot.featureStatus.revision,
      stateBefore.snapshot.featureStatus.revision
    );
    assertNoTempConfig(fixture);
  } finally {
    await fixture.cleanup();
  }
});
