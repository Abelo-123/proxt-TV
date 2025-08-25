// proxy.js (stream-safe + dynamic EPG support)
import express from "express";
import cors from "cors";
import axios from "axios";
import { parseStringPromise, Builder } from "xml2js";
import http from "http";
import https from "https";

const app = express();
const PORT = 8080;

// Move CORS middleware to the very top, before any other middleware or routes
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    // Handle preflight requests
    if (req.method === "OPTIONS") {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Generic stream proxy: /proxy?url=https://...
app.get("/proxy", async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Missing url param");
    console.log('Streaming proxy:', targetUrl);

    try {
        const urlObj = new URL(targetUrl);
        const client = urlObj.protocol === "https:" ? https : http;

        const options = {
            method: "GET",
            headers: {
                "Host": urlObj.host,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "*/*",
                "Connection": "keep-alive",
            }
        };

        // Add anti-bot headers for edgenextcdn.net
        if (targetUrl.includes("edgenextcdn.net")) {
            options.headers["Referer"] = "https://www.shahid.net/";
            options.headers["Origin"] = "https://www.shahid.net";
        }
        if (req.headers.cookie) {
            options.headers["Cookie"] = req.headers.cookie;
        }

        client.get(targetUrl, options, (proxyRes) => {
            res.status(proxyRes.statusCode);
            Object.entries(proxyRes.headers).forEach(([key, value]) => {
                res.setHeader(key, value);
            });

            // If .m3u8 playlist, rewrite all URLs to go through /proxy?url=...
            if (targetUrl.endsWith('.m3u8')) {
                let data = '';
                proxyRes.on('data', chunk => data += chunk);
                proxyRes.on('end', () => {
                    const baseUrl = targetUrl;
                    const rewritten = data.replace(/^(?!#)(.+)$/gm, (line) => {
                        if (line.startsWith('#') || !line.trim()) return line;
                        let newUrl;
                        try {
                            if (/^https?:\/\//.test(line)) {
                                newUrl = `/proxy?url=${encodeURIComponent(line)}`;
                            } else if (line.startsWith('/')) {
                                const urlObj = new URL(baseUrl);
                                let resolved = `${urlObj.protocol}//${urlObj.host}${line}`;
                                newUrl = `/proxy?url=${encodeURIComponent(resolved)}`;
                            } else {
                                const urlObj = new URL(baseUrl);
                                let resolved = new URL(line, urlObj).toString();
                                newUrl = `/proxy?url=${encodeURIComponent(resolved)}`;
                            }
                            return newUrl;
                        } catch (e) {
                            return line;
                        }
                    });
                    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
                    res.end(rewritten);
                });
            } else {
                proxyRes.pipe(res);
            }
        }).on("error", (err) => {
            console.error("Streaming proxy error:", err);
            res.status(500).send("Streaming proxy failed");
        });
    } catch (err) {
        console.error("Proxy setup error:", err);
        res.status(500).send("Proxy setup failed");
    }
});

// Dynamic EPG proxy: /epg?url=https://...
// Dynamic EPG proxy: /epg?channel=ae-us-eastern-feed&format=json
app.get("/epg", async (req, res) => {
    const channelFilter = req.query.channel;
    const format = req.query.format || "xml"; // default is xml
    const epgUrl = "https://tvpass.org/epg.xml";

    if (!channelFilter) {
        console.warn("Missing 'channel' parameter");
        return res.status(400).send("Missing 'channel' query param");
    }

    try {
        console.log(`🔍 Fetching EPG data for channel: ${channelFilter}`);
        const response = await axios.get(epgUrl, { responseType: "text" });
        const xmlData = response.data;

        // Parse XML to JS object
        const parsed = await parseStringPromise(xmlData, { mergeAttrs: true });

        if (!parsed.tv) return res.status(500).send("Invalid EPG format");

        const allProgrammes = parsed.tv.programme || [];
        const filteredProgrammes = allProgrammes.filter(
            (p) => p.channel && p.channel[0] === channelFilter
        );

        if (format === "json") {
            // Respond with JSON
            const jsonEPG = {
                channel: channelFilter,
                programmes: filteredProgrammes.map((p) => ({
                    start: p.start[0],
                    stop: p.stop[0],
                    title: p.title?.[0] || null,
                    subTitle: p["sub-title"]?.[0] || null,
                    desc: p.desc?.[0] || null,
                })),
            };
            res.set("Content-Type", "application/json");
            res.json(jsonEPG);
        } else {
            // Respond with XML
            const builder = new Builder();
            const filteredXml = builder.buildObject({
                tv: { programme: filteredProgrammes },
            });

            res.set("Content-Type", "application/xml");
            res.send(filteredXml);
        }
    } catch (err) {
        console.error("❌ EPG fetch/filter error:", err.message);
        res.status(500).send("Failed to fetch or parse EPG");
    }
});

// Add a fallback 404 handler at the end to clarify missing resources
app.use((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(404).send("Not Found: This resource does not exist on the proxy.");
});


app.listen(PORT, () => {
    console.log(`✅ Proxy server running on http://localhost:${PORT}`);
    console.log("🔁 Stream proxy:  /proxy?url=...");
    console.log("📅 EPG XML proxy: /epg?url=...");
});
console.log("📅 EPG XML proxy: /epg?url=...");
console.log("📅 EPG JSON proxy: /epg?channel=...&format=json");
console.log("🚫 Direct /manifest requests are blocked. Use /proxy?url=...");