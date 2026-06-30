require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NANOBANANA_API_KEY = process.env.NANOBANANA_API_KEY;
const PORT = process.env.PORT || 3001;

if (!ANTHROPIC_API_KEY || !NANOBANANA_API_KEY) {
  console.warn('⚠️  Missing API keys. Copy .env.example to .env and fill in your real keys before using the app.');
}

// ---------------------------------------------------------------------------
// STEP 1: Geocode an address to lat/lon using the free US Census geocoder.
// This works for any US address, no API key required.
// ---------------------------------------------------------------------------
app.post('/api/geocode', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    const response = await fetch(url);
    const data = await response.json();

    const match = data?.result?.addressMatches?.[0];
    if (!match) {
      return res.status(404).json({ error: 'Address not found. Check spelling or try a more complete address.' });
    }

    res.json({
      matchedAddress: match.matchedAddress,
      lat: match.coordinates.y,
      lon: match.coordinates.x,
      county: match.geographies?.['Counties']?.[0]?.NAME || null,
      state: match.geographies?.['States']?.[0]?.NAME || null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Geocoding failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// STEP 2: Research parcel + zoning + overlay data for the address.
// Uses Claude with the web_search tool so it can find the actual town/county
// GIS data and zoning ordinance for ANY location, not just pre-mapped towns.
// ---------------------------------------------------------------------------
app.post('/api/research', async (req, res) => {
  try {
    const { address, lat, lon, county, state } = req.body;
    if (!address) return res.status(400).json({ error: 'Address is required' });

    const prompt = `You are researching a property for a site concept plan. Find real, current, citable information for this property:

Address: ${address}
County: ${county || 'unknown'}
State: ${state || 'unknown'}
Coordinates: ${lat}, ${lon}

Search the web to find:
1. The parcel ID, lot size/acreage, and parcel boundary source (town/county GIS).
2. The zoning district this parcel falls in, and the dimensional requirements for that district (front/side/rear setbacks, max height, max lot coverage, parking requirements) from the actual current zoning ordinance.
3. Any environmental overlays that could constrain the buildable area: wetlands, floodplain, shoreland protection, conservation overlays.

Respond with ONLY the JSON object below. No preamble, no explanation, no markdown formatting, no text before or after. Your entire response must be parseable as JSON:
{
  "parcelId": "string or null",
  "lotSizeAcres": "string or null",
  "zoningDistrict": "string or null",
  "setbacks": { "front": "string or null", "side": "string or null", "rear": "string or null" },
  "maxHeight": "string or null",
  "maxCoverage": "string or null",
  "parkingRequirement": "string or null",
  "overlays": "string describing any wetlands/floodplain/shoreland findings, or 'none found'",
  "sources": ["list of actual URLs or named sources you used"],
  "confidence": "high | medium | low",
  "gaps": "string describing anything you could not verify, or empty string"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');

    // Pull the final text block out of the response (it may include search steps first)
    const textBlocks = data.content.filter(b => b.type === 'text').map(b => b.text);
    const rawText = textBlocks[textBlocks.length - 1] || '';

    // Strip markdown code fences if present
    let cleaned = rawText.replace(/```json|```/g, '').trim();

    // Even with instructions, Claude sometimes adds a sentence before/after the JSON.
    // Extract just the {...} block by finding the first { and matching last }.
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('JSON parse failed. Raw text was:', rawText);
      parsed = {
        error: 'Could not parse structured result',
        rawText: rawText,
        hint: 'The research itself likely succeeded - this is a formatting issue. Check server logs for the raw text.'
      };
    }

    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Research failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// STEP 3: Generate a design-criteria brief in plain English from research data.
// ---------------------------------------------------------------------------
app.post('/api/design-criteria', async (req, res) => {
  try {
    const { address, research, projectDetails } = req.body;

    const prompt = `Based on this verified property research, write a concise design-criteria brief a civil engineer would use to sketch a concept plan.

Address: ${address}
Research findings: ${JSON.stringify(research)}
Project intent: ${JSON.stringify(projectDetails || {})}

Write 5-8 bullet points covering: buildable envelope given setbacks, height/coverage limits, parking, and any overlay constraints. Be specific and use the real numbers found. If something wasn't found, say so plainly rather than inventing a number.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Claude API error');

    res.json({ criteria: data.content.find(b => b.type === 'text')?.text || '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Design criteria generation failed: ' + err.message });
  }
});

// ---------------------------------------------------------------------------
// STEP 4a: Submit a Nano Banana image generation job.
// ---------------------------------------------------------------------------
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const response = await fetch('https://api.nanobananaapi.ai/api/v1/nanobanana/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${NANOBANANA_API_KEY}`
      },
      body: JSON.stringify({ prompt, type: 'TEXTTOIAMGE', numImages: 1 })
    });

    const data = await response.json();
    if (!response.ok || data.code !== 200) {
      throw new Error(data.msg || 'Nano Banana submission failed');
    }

    res.json({ taskId: data.data.taskId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// STEP 4b: Poll a Nano Banana job for completion.
// ---------------------------------------------------------------------------
app.get('/api/generate-image/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const response = await fetch(`https://api.nanobananaapi.ai/api/v1/nanobanana/record-info?taskId=${taskId}`, {
      headers: { 'Authorization': `Bearer ${NANOBANANA_API_KEY}` }
    });
    const data = await response.json();
    res.json(data.data || {});
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`✅ Parcel backend running at http://localhost:${PORT}`);
});
