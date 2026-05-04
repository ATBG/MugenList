/**
 * download_posters.js
 * 
 * Auto-downloads missing posters for all anime in anime_list.json
 * using the Jikan API. Respects the 3 requests/second rate limit.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_FILE = path.join(__dirname, 'data', 'anime_list.json');
const POSTERS_DIR = path.join(__dirname, 'data', 'posters');

// Create posters directory if it doesn't exist
if (!fs.existsSync(POSTERS_DIR)) {
  fs.mkdirSync(POSTERS_DIR, { recursive: true });
}

// Helper to delay execution
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Helper to download an image from a URL
function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location, destPath).then(resolve).catch(reject);
      }

      if (res.statusCode === 200) {
        const file = fs.createWriteStream(destPath);
        res.pipe(file);

        // Handle file stream errors
        file.on('error', (err) => {
          try { file.close(); } catch (e) {}
          fs.unlink(destPath, () => {});
          reject(err);
        });

        res.on('error', (err) => {
          try { file.close(); } catch (e) {}
          fs.unlink(destPath, () => {});
          reject(err);
        });

        file.on('finish', () => {
          file.close();
          resolve();
        });
      } else {
        reject(new Error(`Failed to download image, status code: ${res.statusCode}`));
      }
    }).on('error', err => {
      reject(err);
    });
  });
}

// Fetch anime metadata from Jikan API
function fetchJikanData(malId) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.jikan.moe/v4/anime/${malId}`, {
      headers: { 'User-Agent': 'Web-MugelList-Downloader/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', err => reject(err));
  });
}

async function run() {
  if (!fs.existsSync(DATA_FILE)) {
    console.error('Data file not found:', DATA_FILE);
    return;
  }

  const rawData = fs.readFileSync(DATA_FILE, 'utf-8');
  let animeList = [];
  try {
    animeList = JSON.parse(rawData);
  } catch (e) {
    console.error('Error parsing anime_list.json:', e);
    return;
  }

  // Collect all unique mal_ids
  const missingPosters = [];
  
  for (const root of animeList) {
    if (root.seasons) {
      for (const seasonId of Object.keys(root.seasons)) {
        const malId = root.seasons[seasonId].mal_id;
        const posterPath = path.join(POSTERS_DIR, `${malId}.jpg`);
        // Check if poster is missing
        if (!fs.existsSync(posterPath)) {
          missingPosters.push(malId);
        }
      }
    }
  }

  console.log(`Found ${missingPosters.length} missing posters to download.`);
  if (missingPosters.length === 0) {
    console.log('All posters are already downloaded!');
    return;
  }

  console.log('Starting downloads... (This will take time to avoid Jikan rate limits)');

  for (let i = 0; i < missingPosters.length; i++) {
    const malId = missingPosters[i];
    const posterPath = path.join(POSTERS_DIR, `${malId}.jpg`);

    try {
      console.log(`[${i+1}/${missingPosters.length}] Fetching data for mal_id: ${malId}...`);
      const apiResponse = await fetchJikanData(malId);
      
      if (apiResponse && apiResponse.data && apiResponse.data.images) {
        const imageUrl = apiResponse.data.images.jpg.large_image_url || apiResponse.data.images.jpg.image_url;
        
        if (imageUrl) {
          console.log(`  Downloading image: ${imageUrl}`);
          await downloadImage(imageUrl, posterPath);
          console.log(`  Saved to data/posters/${malId}.jpg`);
        } else {
          console.log(`  No image URL found in Jikan response.`);
        }
      } else {
        console.log(`  Failed to get valid data from Jikan. It might be rate-limited.`);
      }
    } catch (err) {
      console.error(`  Error downloading mal_id ${malId}:`, err.message);
    }
    
    // Sleep to respect the 3 requests per second Jikan rate limit
    await sleep(400); 
  }
  
  console.log('\\nFinished downloading missing posters!');
}

run();
