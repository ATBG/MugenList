/**
 * statsPage.js — Premium statistics dashboard using Chart.js (v2 schema)
 */

import { subscribe } from '../state.js';
import { getInsights } from '../services/insightEngine.js';

let _chart1 = null, _chart2 = null, _chart3 = null;

export function render(container) {
  container.innerHTML = `
    <div class="stats-container">
      <!-- Hero Section -->
      <div class="stats-hero">
        <div class="hero-intro">
          <h1 class="hero-title">Your Anime Insights</h1>
          <p class="hero-subtitle">Track your journey through anime</p>
        </div>
        
        <div class="hero-metrics">
          <div class="metric-block">
            <div class="metric-value" id="stat-franchises" data-target="0">0</div>
            <div class="metric-label">Titles Tracked</div>
            <div class="metric-icon">📚</div>
          </div>
          <div class="metric-block">
            <div class="metric-value" id="stat-completion" data-target="0">0%</div>
            <div class="metric-label">Completion Rate</div>
            <div class="metric-icon">✨</div>
          </div>
          <div class="metric-block">
            <div class="metric-value" id="stat-episodes" data-target="0">0</div>
            <div class="metric-label">Episodes Watched</div>
            <div class="metric-icon">🎬</div>
          </div>
          <div class="metric-block">
            <div class="metric-value" id="stat-hours" data-target="0">0h</div>
            <div class="metric-label">Time Spent</div>
            <div class="metric-icon">⏱️</div>
          </div>
        </div>
      </div>

      <!-- Watch Progress Section -->
      <div class="stats-section">
        <div class="section-header">
          <h2 class="section-title">Watch Progress</h2>
          <p class="section-subtitle">Your viewing patterns</p>
        </div>
        <div class="progress-cards">
          <div class="progress-card" style="border-left: 4px solid #3b82f6;">
            <div class="progress-icon">👀</div>
            <div class="progress-info">
              <div class="progress-number" id="stat-watching">0</div>
              <div class="progress-label">Currently Watching</div>
            </div>
          </div>
          <div class="progress-card" style="border-left: 4px solid #10b981;">
            <div class="progress-icon">✅</div>
            <div class="progress-info">
              <div class="progress-number" id="stat-completed">0</div>
              <div class="progress-label">Completed</div>
            </div>
          </div>
          <div class="progress-card" style="border-left: 4px solid #f59e0b;">
            <div class="progress-icon">⏸️</div>
            <div class="progress-info">
              <div class="progress-number" id="stat-paused">0</div>
              <div class="progress-label">On Hold</div>
            </div>
          </div>
          <div class="progress-card" style="border-left: 4px solid #ef4444;">
            <div class="progress-icon">🚫</div>
            <div class="progress-info">
              <div class="progress-number" id="stat-dropped">0</div>
              <div class="progress-label">Dropped</div>
            </div>
          </div>
          <div class="progress-card" style="border-left: 4px solid #94a3b8;">
            <div class="progress-icon">📖</div>
            <div class="progress-info">
              <div class="progress-number" id="stat-planned">0</div>
              <div class="progress-label">Plan to Watch</div>
            </div>
          </div>
          <div class="progress-card" style="border-left: 4px solid #8b5cf6;">
            <div class="progress-icon">🔁</div>
            <div class="progress-info">
              <div class="progress-number" id="stat-seasons">0</div>
              <div class="progress-label">Total Seasons</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Charts Section -->
      <div class="stats-section">
        <div class="section-header">
          <h2 class="section-title">Distribution & Activity</h2>
          <p class="section-subtitle">See what you like to watch</p>
        </div>
        
        <div class="charts-grid">
          <div class="chart-card">
            <h3 class="chart-title">Genre Favorites</h3>
            <div class="chart-wrapper">
              <canvas id="chart-genre"></canvas>
            </div>
          </div>
          
          <div class="chart-card">
            <h3 class="chart-title">Watch Status Breakdown</h3>
            <div class="chart-wrapper">
              <canvas id="chart-status"></canvas>
            </div>
          </div>
        </div>

        <div class="chart-card chart-card-full">
          <h3 class="chart-title">Monthly Activity Trend</h3>
          <div class="chart-wrapper">
            <canvas id="chart-activity"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;

  // Wait for Chart.js to load via CDN if not present
  if (!window.Chart) {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js';
    s.onload = () => updateCharts();
    document.head.appendChild(s);
  } else {
    updateCharts();
  }

  subscribe('library', updateCharts);
}

function updateCharts() {
  if (!window.Chart) return;
  const ins = getInsights();

  // Update hero metrics with animation
  const updateMetric = (id, value, usePercent = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    
    const target = parseInt(value);
    const current = parseInt(el.textContent);
    const isPercent = usePercent || id.includes('completion');
    const suffix = isPercent ? '%' : '';
    
    // Animate counter
    if (target !== current) {
      animateCounter(el, current, target, suffix);
    } else {
      el.textContent = target + suffix;
    }
  };

  updateMetric('stat-franchises', ins.totalFranchises);
  updateMetric('stat-completion', ins.completionRate, true);
  updateMetric('stat-episodes', ins.episodesWatched);
  updateMetric('stat-hours', Math.round(ins.timeSpentHours));

  // Update progress cards
  document.getElementById('stat-watching').textContent = ins.statusBreakdown.watching;
  document.getElementById('stat-completed').textContent = ins.statusBreakdown.completed;
  document.getElementById('stat-paused').textContent = ins.statusBreakdown.paused;
  document.getElementById('stat-dropped').textContent = ins.statusBreakdown.dropped;
  document.getElementById('stat-planned').textContent = ins.statusBreakdown.plan_to_watch;
  document.getElementById('stat-seasons').textContent = ins.totalSeasons;

  // Defer heavy chart rendering
  const idle = window.requestIdleCallback || function(cb) { return setTimeout(cb, 16); };
  idle(() => {
    // Destroy old charts
    if (_chart1) _chart1.destroy();
    if (_chart2) _chart2.destroy();
    if (_chart3) _chart3.destroy();

    Chart.defaults.color = 'var(--text-muted, #94a3b8)';
    Chart.defaults.font.family = 'Inter, sans-serif';

    // Chart 1: Genre (Doughnut)
    const gKeys = Object.keys(ins.genreDistribution)
      .sort((a,b) => ins.genreDistribution[b] - ins.genreDistribution[a])
      .slice(0, 8);
    const gVals = gKeys.map(k => ins.genreDistribution[k]);
    const ctx1 = document.getElementById('chart-genre');
    if (ctx1) {
      _chart1 = new Chart(ctx1, {
        type: 'doughnut',
        data: {
          labels: gKeys,
          datasets: [{
            data: gVals,
            backgroundColor: ['#5c6bc0', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#ef4444', '#3b82f6', '#10b981'],
            borderWidth: 2,
            borderColor: 'var(--bg-primary, #0f172a)'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          animation: {
            duration: 800,
            easing: 'easeOutCubic'
          },
          plugins: {
            legend: {
              position: 'right',
              labels: {
                padding: 16,
                font: { size: 12 }
              }
            },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              padding: 12,
              titleFont: { size: 13 },
              bodyFont: { size: 12 },
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 1
            }
          }
        }
      });
    }

    // Chart 2: Status (Pie)
    const sLabels = ['Watching', 'Completed', 'Plan to Watch', 'On Hold', 'Dropped'];
    const sKeys = ['watching', 'completed', 'plan_to_watch', 'paused', 'dropped'];
    const sVals = sKeys.map(k => ins.statusBreakdown[k] || 0);
    const ctx2 = document.getElementById('chart-status');
    if (ctx2) {
      _chart2 = new Chart(ctx2, {
        type: 'pie',
        data: {
          labels: sLabels,
          datasets: [{
            data: sVals,
            backgroundColor: ['#3b82f6', '#10b981', '#94a3b8', '#f59e0b', '#ef4444'],
            borderWidth: 2,
            borderColor: 'var(--bg-primary, #0f172a)'
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          animation: {
            duration: 800,
            easing: 'easeOutCubic'
          },
          plugins: {
            legend: {
              position: 'right',
              labels: {
                padding: 16,
                font: { size: 12 }
              }
            },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              padding: 12,
              titleFont: { size: 13 },
              bodyFont: { size: 12 },
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 1
            }
          }
        }
      });
    }

    // Chart 3: Activity (Bar)
    const aKeys = Object.keys(ins.monthlyActivity).sort();
    const aVals = aKeys.map(k => ins.monthlyActivity[k]);
    const ctx3 = document.getElementById('chart-activity');
    if (ctx3) {
      _chart3 = new Chart(ctx3, {
        type: 'bar',
        data: {
          labels: aKeys,
          datasets: [{
            label: 'Seasons Updated',
            data: aVals,
            backgroundColor: '#5c6bc0',
            borderRadius: 6,
            borderSkipped: false
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          animation: {
            duration: 800,
            easing: 'easeOutCubic'
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(15, 23, 42, 0.8)',
              padding: 12,
              titleFont: { size: 13 },
              bodyFont: { size: 12 },
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderWidth: 1,
              mode: 'index',
              intersect: false
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              grid: { color: 'rgba(255, 255, 255, 0.05)' },
              ticks: { font: { size: 11 } }
            },
            x: {
              grid: { display: false },
              ticks: { font: { size: 11 } }
            }
          }
        }
      });
    }
  });
}

function animateCounter(el, from, to, suffix = '') {
  const duration = 1000;
  const start = Date.now();
  
  const animate = () => {
    const elapsed = Date.now() - start;
    const progress = Math.min(elapsed / duration, 1);
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(from + (to - from) * easeOut);
    
    el.textContent = current + suffix;
    
    if (progress < 1) {
      requestAnimationFrame(animate);
    }
  };
  
  requestAnimationFrame(animate);
}
