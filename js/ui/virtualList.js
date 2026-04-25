/**
 * virtualList.js — Lightweight DOM-virtualized collection for grid/list layouts
 *
 * Keeps DOM nodes under a tight cap (default 50) by only rendering
 * the items visible in the scroll viewport. Uses absolute positioning
 * inside a padded stage element to allow smooth native scrolling.
 */

const raf = window.requestAnimationFrame || ((cb) => setTimeout(cb, 16));

export class VirtualCollection {
  constructor(container, {
    renderItem,
    estimateHeight,
    targetWidth = 220,
    gap = 16,
    mode = 'grid',
    maxNodes = 50,
  }) {
    this.container = container;
    this.renderItem = renderItem;
    this.estimateHeight = estimateHeight;
    this.targetWidth = targetWidth;
    this.gap = gap;
    this.mode = mode;
    this.maxNodes = maxNodes;

    this.items = [];
    this.columns = 1;
    this.itemHeight = 320;
    this.itemWidth = targetWidth;
    this._scheduled = false;
    this._safeMode = false; // Fallback render mode if virtualization fails
    this._deferredOnce = false; // Track if we've deferred once to avoid infinite loops

    this.stage = document.createElement('div');
    this.stage.style.position = 'relative';
    this.stage.style.width = '100%';
    this.stage.style.minHeight = '100%';
    this.stage.style.willChange = 'transform';
    
    // Ensure container is ready to receive items
    this.container.innerHTML = '';
    this.container.style.position = 'relative';
    this.container.style.overflowY = 'auto';
    this.container.style.overflowX = 'hidden';
    
    // For grid mode, use grid layout. For list mode, use flex as before
    if (mode === 'grid') {
      this.container.style.display = 'grid';
      this.container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(' + targetWidth + 'px, 1fr))';
      this.container.style.gap = gap + 'px';
      this.container.style.padding = gap + 'px';
      this.container.style.alignContent = 'start';
      this.container.style.backgroundColor = '#0B0E14';
      
      // Stage shouldn't control layout in grid mode - just hold the items
      this.stage.style.display = 'contents'; // Make stage transparent to layout
    } else {
      this.container.style.display = 'flex';
      this.container.style.flexDirection = 'column';
    }
    
    this.container.appendChild(this.stage);

    this._onScroll = this.scheduleUpdate.bind(this);
    this._onResize = this.scheduleUpdate.bind(this);
    this.container.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('resize', this._onResize);
    
    // Add error recovery
    this._errorCount = 0;
    this._maxErrors = 3;
    
    console.log('🔧 VirtualCollection initialized for', mode, 'mode. Container:', container, 'clientHeight:', container.clientHeight);
  }

  destroy() {
    this.container.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('resize', this._onResize);
    this.stage.innerHTML = '';
    this.items = [];
    this._scheduled = false;
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.stage.innerHTML = '';
    this._heightMeasured = false;
    this.scheduleUpdate(true);
  }

  setItems(items) {
    console.log('📥 setItems called with', items.length, 'items');
    if (!items || items.length === 0) {
      console.warn('⚠️  setItems: items array is empty!');
    }
    this.items = items || [];
    console.log('📥 setItems: this.items.length =', this.items.length);
    this.scheduleUpdate(true);
  }

  scheduleUpdate(force = false) {
    if (force) this._force = true;
    if (this._scheduled) return;
    this._scheduled = true;
    raf(() => {
      this._scheduled = false;
      this.update(this._force);
      this._force = false;
    });
  }

  update(forceLayout = false) {
    try {
      const viewH = this.container.clientHeight || 0;
      const viewW = this.container.clientWidth || this.targetWidth;

      console.log('📊 VirtualCollection.update called: viewH=' + viewH + ', viewW=' + viewW + ', items=' + this.items.length);

      // SAFEGUARD: If viewH is 0, we may have a layout issue. Try a deferred update first.
      if (viewH === 0 && this.items.length > 0 && !this._deferredOnce) {
        console.warn('⚠️  VirtualCollection: viewH=0! Scheduling deferred update. Container:', this.container);
        this._deferredOnce = true;
        // Force another measure after a frame
        requestAnimationFrame(() => {
          this._deferredOnce = false;
          const newViewH = this.container.clientHeight;
          console.log('🔄 Deferred check: newViewH=' + newViewH);
          if (newViewH > 0) {
            console.log('✅ VirtualCollection: Deferred update found height, re-measuring...');
            this.scheduleUpdate(true);
          } else {
            console.warn('⚠️  VirtualCollection: Still no height after defer, using safe mode.');
            this._safeMode = true;
            this._renderSafeMode();
          }
        });
        return;
      } else if (viewH > 0) {
        this._safeMode = false;
        this._errorCount = 0;
      }

      this.columns = Math.max(1, this.mode === 'grid'
        ? Math.floor((viewW + this.gap) / (this.targetWidth + this.gap))
        : 1);
      this.itemWidth = this.mode === 'grid'
        ? (viewW - this.gap * (this.columns - 1)) / this.columns
        : viewW;

      if (forceLayout || !this._heightMeasured) {
        this.itemHeight = this._measureHeight();
        this._heightMeasured = true;
      }

      const totalRows = Math.ceil(this.items.length / this.columns);
      const totalHeight = Math.max(totalRows * (this.itemHeight + this.gap) - this.gap, 0);
      this.stage.style.height = `${totalHeight}px`;

      const scrollTop = this.container.scrollTop || 0;
      // OVERHAUL: Increase buffer so scrolling fast doesn't show blank area
      const overscan = 3; 
      const firstRow = Math.max(0, Math.floor(scrollTop / (this.itemHeight + this.gap)) - overscan);
      const rowsVisible = Math.ceil((viewH || 500) / (this.itemHeight + this.gap)) + (overscan * 2);
      let startIndex = firstRow * this.columns;
      let endIndex = Math.min(this.items.length - 1, (firstRow + rowsVisible) * this.columns - 1);

      // SAFEGUARD: Ensure valid range
      if (startIndex > endIndex || startIndex >= this.items.length) {
        console.warn('⚠️  VirtualCollection: Invalid range [' + startIndex + ', ' + endIndex + ']. Rendering first batch.');
        // Fallback: render first visible batch
        endIndex = Math.min(this.items.length - 1, Math.max(startIndex, 19));
        startIndex = Math.max(0, endIndex - 19);
      }

      // Give a larger maxNodes limit to accommodate overscan. We need at least enough for grid.
      if (endIndex - startIndex + 1 > this.maxNodes) {
        endIndex = Math.min(this.items.length - 1, startIndex + this.maxNodes + (overscan * 4) - 1);
      }

      console.log('📊 VirtualCollection.update: renderWindow [' + startIndex + ', ' + endIndex + '] of ' + this.items.length + ' items. viewH=' + viewH);
      this._renderWindow(startIndex, endIndex);
    } catch (e) {
      this._errorCount++;
      console.error('❌ VirtualCollection update error:', e, 'count:', this._errorCount);
      
      if (this._errorCount >= this._maxErrors) {
        console.warn('🛡️  VirtualCollection: Too many errors, falling back to safe mode');
        this._safeMode = true;
        this._renderSafeMode();
        this._errorCount = 0;
      }
    }
  }

  _measureHeight() {
    if (this.items.length === 0) return this.mode === 'grid' ? 320 : 140;
    if (typeof this.estimateHeight === 'function') {
      const h = this.estimateHeight(this.items[0], this.itemWidth, this.mode);
      if (h) return h;
    }
    return this.mode === 'grid' ? 360 : 140;
  }

  // SAFEGUARD: Render items without virtualization (simple fallback mode)
  _renderSafeMode() {
    console.log('🛡️  Safe mode: rendering first 50 items without virtualization');
    const toRender = Math.min(50, this.items.length);
    this.stage.innerHTML = '';
    this.stage.style.height = 'auto';
    this.stage.style.position = 'relative';
    this.stage.style.display = 'grid';
    this.stage.style.gridTemplateColumns = this.mode === 'grid' 
      ? 'repeat(auto-fill, minmax(200px, 1fr))' 
      : '1fr';
    this.stage.style.gap = (this.gap) + 'px';
    this.stage.style.padding = (this.gap) + 'px';
    this.stage.style.width = '100%';
    this.stage.style.alignContent = 'start';
    
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < toRender; i++) {
      const item = this.items[i];
      try {
        const node = this.renderItem(item);
        if (!node) {
          console.warn('⚠️  renderItem returned null for item[' + i + ']');
          continue;
        }
        node.dataset.virtualKey = item.root_mal_id || i;
        node.style.width = '100%';
        fragment.appendChild(node);
      } catch (e) {
        console.error('⚠️  Error rendering item[' + i + ']:', e);
      }
    }
    this.stage.appendChild(fragment);
    
    console.log('✅ Safe mode: rendered ' + toRender + ' items');
    if (this.items.length > toRender) {
      console.info('ℹ️  Safe mode: ' + (this.items.length - toRender) + ' items not rendered (capacity limit)');
    }
  }

  _renderWindow(start, end) {
    try {
      console.log('🎨 _renderWindow: rendering items [' + start + ', ' + end + '] out of ' + this.items.length);
      const neededKeys = new Set();
      const toAppend = [];

      for (let i = start; i <= end; i++) {
        const item = this.items[i];
        if (!item) {
          console.warn('   ⚠️  item[' + i + '] is null/undefined');
          continue;
        }
        const key = item.root_mal_id || i;
        neededKeys.add(String(key));
        let node = this.stage.querySelector(`[data-virtual-key="${key}"]`);
        if (!node) {
          try {
            node = this.renderItem(item);
            if (!node) {
              console.error('   ❌ renderItem returned null/undefined for item', item);
              continue;
            }
            node.dataset.virtualKey = key;
            node.style.position = 'absolute';
            node.style.willChange = 'transform, opacity';
            node.style.width = `${this.itemWidth}px`;
            toAppend.push(node);
          } catch (err) {
            console.error('   ❌ Error rendering item[' + i + ']:', err.message);
            node = null;
            continue;
          }
        }
        const row = Math.floor(i / this.columns);
        const col = i % this.columns;
        const top = row * (this.itemHeight + this.gap);
        const left = col * (this.itemWidth + this.gap);
        if (node) {
          node.style.transform = `translate(${left}px, ${top}px)`;
        }
      }

      // Remove nodes not needed
      this.stage.querySelectorAll('[data-virtual-key]').forEach(el => {
        if (!neededKeys.has(el.dataset.virtualKey)) el.remove();
      });

      if (toAppend.length > 0) {
        console.log('📌 Appending ' + toAppend.length + ' new nodes to stage');
        const fragment = document.createDocumentFragment();
        toAppend.forEach(el => fragment.appendChild(el));
        this.stage.appendChild(fragment);
        console.log('✅ Nodes appended. Total DOM nodes now:', this.stage.querySelectorAll('[data-virtual-key]').length);
      } else {
        console.log('ℹ️  No new nodes to append (reusing existing)');
      }
    } catch (e) {
      console.error('❌ _renderWindow error:', e);
      // Emergency fallback: clear stage and try safe mode
      this.stage.innerHTML = '';
      this._safeMode = true;
      this._renderSafeMode();
    }
  }
}
