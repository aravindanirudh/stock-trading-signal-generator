- Built for Antigravity CLI.
- To make it work, add your Upstox Analysis API key in @run_routine.js.
- Then, copy and paste the prompt given below in CLI environment while tagging the skill file.

Morning Prompt v5:
```
@morning-catalyst It is 09:08 AM on [Date]. Execute your routine.
```

Morning Prompt v4:
```
@morning-catalyst It is 09:08 AM and today is <date>. Execute your routine exactly as defined in your Version 2.0 instructions.
    1. Run terminal command node run_routine.js and wait for it to complete.
    2. Read data/analysis_results.json to identify the mathematically qualified tickers.
    3. CRITICAL CONTEXT CHECK: Open data/raw_fetched_data.json and cross-examine the raw corporate filings, board meeting descriptions, and announcement texts specifically for the tickers identified in step 2.
    4. Filter out or adjust any ticker that has a hidden negative catalyst (e.g., executive resignations, bad litigation, low-impact noise).
    5. Output the filtered raw data points and print the final Markdown table.
If no setups survive or if the script returns nothing, reply with "Stand Aside".
```

Afternoon Audit Prompt:
```
@morning-catalyst AFTERNOON AUDIT MODE. > Read the data/analysis_results.json file generated this morning.
Scan the rawDataPoints array and find any stocks that had an overnight catalyst (Earnings or Bulk Deal) but were disqualified from Strategy 1 because their gapPct was strictly between 0.5% and 0.99%.
Output these specific stocks in a simple Markdown table with the columns: [Ticker] | [Catalyst Type] | [Actual Gap %].
Do not generate trade setups or stop-losses.
```

Morning Prompt v3:
```
@morning-catalyst It is 09:08 AM and today is <date>. Execute your routine exactly as defined in your Version 2.0 instructions.
    1. Run node run_routine.js.
    2. Read data/analysis_results.json.
    3. Output the raw data points and the final Markdown table.
If the script returns no setups, output "Stand Aside".
```

Morning Prompt v2:
```
@morning-catalyst It is 09:08 AM and today is <date>. Execute your full routine exactly as defined in your instructions.
    1. Launch Playwright strictly using Firefox. Enforce a 10-second maximum timeout and use waitUntil: 'domcontentloaded' for all navigations.
    2. Perform the Step 1 Cookie Warmup on nseindia.com.
    3. Fetch all 6 NSE JSON APIs and the 1 BSE JSON API. Ensure you dynamically inject the correct dates (DD-MM-YYYY for NSE, YYYYMMDD for BSE). Use the strict page.evaluate() bypass method for BSE.
    4. Fetch the Global Macros from investing.com.
    5. Run the data through your Strategy Aggregator (Gap-and-Go, Invisible Floor, and Squeeze).
    6. DO NOT fetch historical Yahoo Finance data for every stock. ONLY pull it for the specific 2 or 3 tickers that pass the initial catalyst screens.
    7. Output the results using the strict Markdown Table format. List your raw data points first.
If no stocks meet the strict criteria across any of the 3 strategies, simply reply with "Stand Aside".
```

Morning Prompt v1:
```
@morning-catalyst It is 09:08 AM. Execute your full routine exactly as defined in your instructions. 

1. Perform the Step 1 Cookie Warmup on nseindia.com (catch and ignore any navigation errors, just ensure the session starts).
2. Fetch all 6 JSON APIs via Playwright. Ensure you dynamically inject today's date and the date 7 days ago for the Board Meetings link. Format of date is DD-MM-YYYY for NSE APIs and YYYYMMDD for the BSE API.
3. Fetch the Global Macros from investing.com.
4. Run the data through your Strategy Aggregator (Gap-and-Go, Invisible Floor, and Squeeze). 
5. Output the results using the strict Markdown Table format. List your raw data points first. 

If no stocks meet the strict criteria across any of the 3 strategies, simply reply with "Stand Aside".
```

Prompt to test if eveyrthing works:
```
@morning-catalyst Run a strict connection diagnostic test. 

1. Execute Step 1: Perform the Cookie Warmup on nseindia.com for 2 seconds.
2. Execute Step 2: Fetch ONLY the FII/DII (All Exchanges) JSON API. 
3. Read the JSON text from the browser screen and tell me the exact "Net Value" for FIIs/FPIs from yesterday.

Do not run the strategy aggregator. Just confirm the data fetch was successful.
```

Dry run test prompt:
```
@morning-catalyst DRY RUN / DIAGNOSTIC MODE. Do not perform strategy aggregation or trade analysis today. Execute a strict connection test for all your data sources.
    1. Launch Playwright using Firefox only.
    2. Perform the Step 1 Cookie Warmup on nseindia.com (max 10s timeout, domcontentloaded).
Phase 2: API Extraction Test
Fetch all 7 JSON APIs (6 NSE, 1 BSE) strictly using the instructions in your SKILL file. Inject today's date where necessary.
Phase 3: Macro & Historical Test
    1. Fetch the Global Macros from investing.com.
    2. Fetch the Yahoo Finance 3-month historical JSON for a dummy ticker (e.g., RELIANCE.NS).
Output:
Do not generate trade setups. Output a simple diagnostic Markdown checklist. For each of the 9 endpoints (Warmup, 6 NSE, 1 BSE, Investing, Yahoo), state [SUCCESS] or [FAILURE], followed by a brief 1-2 sentence snippet of the raw data extracted to prove it worked.
```