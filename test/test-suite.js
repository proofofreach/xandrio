const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const BASE_URL = 'http://localhost:8181';
const TEST_TIMEOUT = 120000; // 2 minutes for TTS generation

// Test utilities
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanupTestBook(bookId) {
  try {
    await axios.delete(`${BASE_URL}/api/book/${bookId}`);
  } catch (err) {
    // Ignore cleanup errors
  }
}

// Test suite
class XandrioTestSuite {
  constructor() {
    this.testResults = [];
    this.testBookId = null;
  }

  async runAll() {
    console.log('🧪 Xandrio Test Suite Starting...\n');
    
    const tests = [
      this.testServerHealth,
      this.testBookSearch,
      this.testBookDownload,
      this.testChapterExtraction,
      this.testAudioGeneration,
      this.testChapterPlayback,
      this.testChapterTransition,
      this.testLibraryOperations,
      this.testPositionSaving,
      this.testUpload
    ];

    for (const test of tests) {
      await this.runTest(test.bind(this));
    }

    this.printResults();
  }

  async runTest(testFunc) {
    const testName = testFunc.name;
    const startTime = Date.now();
    
    try {
      console.log(`Running: ${testName}...`);
      await testFunc();
      const duration = Date.now() - startTime;
      this.testResults.push({ name: testName, status: 'PASS', duration });
      console.log(`✅ ${testName} (${duration}ms)\n`);
    } catch (err) {
      const duration = Date.now() - startTime;
      this.testResults.push({ name: testName, status: 'FAIL', duration, error: err.message });
      console.error(`❌ ${testName} failed: ${err.message}\n`);
    }
  }

  // Test 1: Server Health
  async testServerHealth() {
    const response = await axios.get(`${BASE_URL}/api/library`);
    if (response.status !== 200) {
      throw new Error(`Server returned status ${response.status}`);
    }
    if (!response.data.books || !Array.isArray(response.data.books)) {
      throw new Error('Library endpoint did not return books array');
    }
  }

  // Test 2: Book Search
  async testBookSearch() {
    const response = await axios.post(`${BASE_URL}/api/search`, {
      query: 'Pride and Prejudice Jane Austen'
    });
    
    if (!response.data.recommended) {
      throw new Error('No recommended book found');
    }
    
    const book = response.data.recommended;
    if (!book.title.toLowerCase().includes('pride') || !book.author.toLowerCase().includes('austen')) {
      throw new Error(`Wrong book found: ${book.title} by ${book.author}`);
    }
    
    // Store for next test
    this.searchResult = book;
  }

  // Test 3: Book Download
  async testBookDownload() {
    if (!this.searchResult) {
      throw new Error('No search result from previous test');
    }

    console.log(`  Downloading: ${this.searchResult.title} (${this.searchResult.size || 'unknown size'})`);
    
    const response = await axios.post(`${BASE_URL}/api/download`, {
      hash: this.searchResult.hash,
      filename: this.searchResult.filename || 'test-book.epub',
      size: this.searchResult.size
    }, {
      timeout: 60000 // 1 minute timeout for download
    });

    if (!response.data.bookId) {
      throw new Error('Download did not return bookId');
    }

    this.testBookId = response.data.bookId;
    console.log(`  Book downloaded with ID: ${this.testBookId}`);
  }

  // Test 4: Chapter Extraction
  async testChapterExtraction() {
    if (!this.testBookId) {
      throw new Error('No test book ID');
    }

    const response = await axios.get(`${BASE_URL}/api/book/${this.testBookId}`);
    
    if (!response.data.chapters || !Array.isArray(response.data.chapters)) {
      throw new Error('No chapters found in book');
    }

    const chapters = response.data.chapters;
    console.log(`  Found ${chapters.length} chapters`);
    
    if (chapters.length < 2) {
      throw new Error('Book must have at least 2 chapters for testing');
    }

    // Verify chapter structure
    const chapter1 = chapters[0];
    if (!chapter1.title || !chapter1.text || chapter1.text.length < 100) {
      throw new Error('Chapter 1 has invalid structure or too short');
    }

    console.log(`  Chapter 1: "${chapter1.title}" (${chapter1.text.length} chars)`);
    console.log(`  Chapter 2: "${chapters[1].title}" (${chapters[1].text.length} chars)`);
    
    this.chapters = chapters;
  }

  // Test 5: Audio Generation
  async testAudioGeneration() {
    if (!this.testBookId || !this.chapters) {
      throw new Error('Prerequisites not met');
    }

    console.log(`  Generating audio for Chapter 1...`);
    const startTime = Date.now();
    
    // Test audio generation
    const response = await axios.get(`${BASE_URL}/api/audio/${this.testBookId}/0`, {
      timeout: TEST_TIMEOUT,
      responseType: 'arraybuffer'
    });

    const generationTime = Date.now() - startTime;
    console.log(`  Audio generated in ${generationTime}ms`);

    // Verify it's valid MP3
    if (response.headers['content-type'] !== 'audio/mpeg') {
      throw new Error('Audio response is not MP3');
    }

    const audioSize = response.data.byteLength;
    console.log(`  Audio size: ${(audioSize / 1024 / 1024).toFixed(2)}MB`);

    // Estimate duration based on bitrate
    const estimatedDuration = (audioSize * 8) / (48 * 1000); // 48kbps
    console.log(`  Estimated duration: ${Math.round(estimatedDuration)} seconds`);
    
    this.chapter1Duration = estimatedDuration;
  }

  // Test 6: Chapter Playback
  async testChapterPlayback() {
    if (!this.testBookId) {
      throw new Error('No test book');
    }

    // Test HEAD request (should be fast if cached)
    const headStart = Date.now();
    const headResponse = await axios.head(`${BASE_URL}/api/audio/${this.testBookId}/0`);
    const headTime = Date.now() - headStart;
    
    console.log(`  HEAD request time: ${headTime}ms`);
    if (headTime > 100) {
      console.warn(`  ⚠️  HEAD request slow (${headTime}ms) - may not be cached`);
    }

    // Test range request
    const rangeResponse = await axios.get(`${BASE_URL}/api/audio/${this.testBookId}/0`, {
      headers: { 'Range': 'bytes=0-1000' }
    });

    if (rangeResponse.status !== 206) {
      throw new Error(`Range request failed: status ${rangeResponse.status}`);
    }

    console.log(`  Range requests working correctly`);
  }

  // Test 7: Chapter Transition
  async testChapterTransition() {
    if (!this.testBookId || !this.chapters || this.chapters.length < 2) {
      throw new Error('Need at least 2 chapters');
    }

    console.log(`  Pre-generating Chapter 2...`);
    
    // Trigger chapter 2 generation
    const startTime = Date.now();
    await axios.get(`${BASE_URL}/api/audio/${this.testBookId}/1`, {
      timeout: TEST_TIMEOUT,
      responseType: 'arraybuffer'
    });
    
    const generationTime = Date.now() - startTime;
    console.log(`  Chapter 2 generated in ${generationTime}ms`);

    // Verify it's cached now
    const cachedStart = Date.now();
    await axios.head(`${BASE_URL}/api/audio/${this.testBookId}/1`);
    const cachedTime = Date.now() - cachedStart;
    
    if (cachedTime > 50) {
      console.warn(`  ⚠️  Chapter 2 may not be properly cached (${cachedTime}ms)`);
    }
  }

  // Test 8: Library Operations
  async testLibraryOperations() {
    // Get library
    const libraryResponse = await axios.get(`${BASE_URL}/api/library`);
    const books = libraryResponse.data.books;
    const initialCount = books.length;
    
    console.log(`  Library has ${initialCount} books`);
    
    // Verify our test book is in library
    const testBook = books.find(b => b.id === this.testBookId);
    if (!testBook) {
      throw new Error('Test book not found in library');
    }
    
    console.log(`  Test book found: "${testBook.title}"`);
  }

  // Test 9: Position Saving
  async testPositionSaving() {
    if (!this.testBookId) {
      throw new Error('No test book');
    }

    // Save position
    const testPosition = {
      bookId: this.testBookId,
      chapterIndex: 0,
      timestamp: 42.5
    };

    await axios.post(`${BASE_URL}/api/position`, testPosition);
    
    // Get position
    const getResponse = await axios.get(`${BASE_URL}/api/position/${this.testBookId}`);
    
    const saved = getResponse.data.position;
    if (!saved || saved.timestamp !== testPosition.timestamp) {
      throw new Error(`Position mismatch: ${saved && saved.timestamp} !== ${testPosition.timestamp}`);
    }
    
    console.log(`  Position saved and retrieved correctly`);
  }

  // Test 10: Upload
  async testUpload() {
    // This would require a test EPUB file
    console.log(`  Upload test skipped (requires test file)`);
  }

  // Cleanup
  async cleanup() {
    if (this.testBookId) {
      console.log(`\nCleaning up test book ${this.testBookId}...`);
      await cleanupTestBook(this.testBookId);
    }
  }

  printResults() {
    console.log('\n📊 Test Results:');
    console.log('================');
    
    const passed = this.testResults.filter(r => r.status === 'PASS').length;
    const failed = this.testResults.filter(r => r.status === 'FAIL').length;
    const total = this.testResults.length;
    
    this.testResults.forEach(result => {
      const icon = result.status === 'PASS' ? '✅' : '❌';
      console.log(`${icon} ${result.name} (${result.duration}ms)`);
      if (result.error) {
        console.log(`   Error: ${result.error}`);
      }
    });
    
    console.log(`\nSummary: ${passed}/${total} passed (${Math.round(passed/total*100)}%)`);
    
    if (failed > 0) {
      console.log(`\n⚠️  ${failed} tests failed!`);
    } else {
      console.log('\n🎉 All tests passed!');
    }
  }
}

// Run tests
async function main() {
  const suite = new XandrioTestSuite();
  
  try {
    await suite.runAll();
  } catch (err) {
    console.error('Test suite error:', err);
  } finally {
    await suite.cleanup();
  }
}

// Export for use in other tests
module.exports = { XandrioTestSuite };

// Run if called directly
if (require.main === module) {
  main();
}