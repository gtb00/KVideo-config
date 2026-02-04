const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 配置 ===
const CONFIG_PATH = path.join(__dirname, "KVideo-config.json");
const REPORT_PATH = path.join(__dirname, "report.md");
const ADULT_JSON_PATH = path.join(__dirname, "adult.json");
const LITE_JSON_PATH = path.join(__dirname, "lite.json");

const SEARCH_KEYWORD = process.argv[2] || "斗罗大陆";
const TIMEOUT_MS = 10000;
const CONCURRENT_LIMIT = 5; 
const MAX_RETRY = 2;

// 污染词库：如果搜索结果包含这些词，视为无效源
const POLLUTED_KEYWORDS = ["广告", "博彩", "注册", "联系Q", "维护", "加群"];

if (!fs.existsSync(CONFIG_PATH)) {
    console.error("❌ 配置文件不存在:", CONFIG_PATH);
    process.exit(1);
}

const configArray = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

const delay = ms => new Promise(r => setTimeout(r, ms));

/**
 * 核心检测逻辑
 */
async function testSource(item) {
    const url = item.baseUrl;
    let errorReason = "";

    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
        try {
            // 1. 基础连通性测试 (超时控制)
            const ping = await axios.get(url, { timeout: TIMEOUT_MS });
            if (ping.status !== 200) throw new Error(`HTTP_${ping.status}`);

            // 2. 搜索可用性测试 (ac=detail 获取带名称的列表)
            const searchUrl = `${url}?ac=detail&wd=${encodeURIComponent(SEARCH_KEYWORD)}`;
            const res = await axios.get(searchUrl, { timeout: TIMEOUT_MS });
            
            if (!res.data || !res.data.list) {
                errorReason = "返回格式非法";
            } else if (res.data.list.length === 0) {
                errorReason = "搜索无结果";
            } else {
                // 3. 内容污染验证
                const sampleName = res.data.list[0].vod_name || "";
                if (POLLUTED_KEYWORDS.some(k => sampleName.includes(k))) {
                    errorReason = "检测到广告污染源";
                }
            }

            if (errorReason) throw new Error(errorReason);
            return { success: true, reason: "正常" };

        } catch (e) {
            errorReason = e.message;
            if (attempt < MAX_RETRY) await delay(1000);
        }
    }
    return { success: false, reason: errorReason };
}

/**
 * 并发控制执行器
 */
async function queueRun(items, limit) {
    const results = [];
    const running = new Set();
    for (const item of items) {
        if (running.size >= limit) await Promise.race(running);
        const p = testSource(item).then(res => ({ ...item, ...res }));
        running.add(p);
        p.finally(() => running.delete(p));
        results.push(p);
    }
    return Promise.all(results);
}

(async () => {
    console.log(`🚀 开始扫描 API 质量... 目标关键词: ${SEARCH_KEYWORD}`);
    
    const rawResults = await queueRun(configArray, CONCURRENT_LIMIT);

    // 1. 构建 Adult.json (保留所有，标记异常)
    const adultData = rawResults.map(item => {
        const { success, reason, ...cleanItem } = item;
        const finalItem = {
            id: cleanItem.id,
            name: cleanItem.name,
            baseUrl: cleanItem.baseUrl,
            group: cleanItem.group || "normal",
            enabled: cleanItem.enabled !== false // 默认 true
        };

        if (!success) {
            finalItem.enabled = false;
            finalItem._comment = `异常记录: ${reason}`;
        }
        return finalItem;
    });

    fs.writeFileSync(ADULT_JSON_PATH, JSON.stringify(adultData, null, 2), "utf-8");

    // 2. 构建 Lite.json (严选模式)
    const liteData = adultData.filter(item => {
        const isAdult = item.group === "adult";
        const isBroken = item.enabled === false || item._comment;
        return !isAdult && !isBroken;
    });

    fs.writeFileSync(LITE_JSON_PATH, JSON.stringify(liteData, null, 2), "utf-8");

    // 3. 生成 Markdown 简报
    const cstTime = new Date(Date.now() + 8 * 60 * 60 * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    let md = `# ⚙️ API 自动化检测报告\n\n`;
    md += `> 更新时间: ${cstTime} (北京时间)\n\n`;
    md += `| 状态 | 资源名称 | 分组 | 检测结果 |\n| :--- | :--- | :--- | :--- |\n`;
    rawResults.forEach(r => {
        md += `| ${r.success ? '✅' : '❌'} | ${r.name} | ${r.group} | ${r.reason} |\n`;
    });
    fs.writeFileSync(REPORT_PATH, md, "utf-8");

    console.log("✨ 任务完成：文件已同步更新。");
})();
