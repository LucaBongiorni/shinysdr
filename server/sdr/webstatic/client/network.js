var sdr = sdr || {};
(function () {
  'use strict';
  
  var Cell = sdr.values.Cell;
  var typeFromDesc = sdr.values.typeFromDesc;
  
  var network = sdr.network = {};
  
  // Connectivity management
  var isDown = false;
  var queuedToRetry = Object.create(null);
  var isDownCheckXHR = new XMLHttpRequest();
  var isDownCheckInterval;
  isDownCheckXHR.onreadystatechange = function() {
    if (isDownCheckXHR.readyState === 4) {
      if (isDownCheckXHR.status > 0 && isDownCheckXHR.status < 500) {
        isDown = false;
        clearInterval(isDownCheckInterval);
        for (var key in queuedToRetry) {
          var retrier = queuedToRetry[key];
          delete queuedToRetry[key];
          retrier();
        }
      }
    }
  };
  function isDownCheck() {
    isDownCheckXHR.open('HEAD', '/', true);
    isDownCheckXHR.send();
  }
  
  function statusCategory(httpStatus) {
    return Math.floor(httpStatus / 100);
  }
  
  function makeXhrStateCallback(r, retry, whenReady, whenOther) {
    return function() {
      if (r.readyState === 4) {
        if (r.status === 0) {
          // network error
          if (!isDown) {
            console.log('Network error, suspending activities');
            isDown = true;
            isDownCheckInterval = setInterval(isDownCheck, 1000);
          }
          retry();  // cause enqueueing under isDown condition
          return;
        }
        isDown = false;
        whenReady(r);
      }
    };
  }
  
  function xhrput(url, data, opt_callback) {
    if (isDown) {
      queuedToRetry['PUT ' + url] = function() { xhrput(url, data); };
      return;
    }
    var r = new XMLHttpRequest();
    r.open('PUT', url, true);
    r.setRequestHeader('Content-Type', 'application/json');
    r.onreadystatechange = makeXhrStateCallback(r,
      function putRetry() {
        xhrput(url, data); // causes enqueueing
      },
      function putDone(r) {
        if (opt_callback) opt_callback(r);
      });
    r.send(data);
    console.log(url, data);
  }
  network.xhrput = xhrput;
  
  function xhrpost(url, data, opt_callback) {
    // TODO add retry behavior (once we know our idempotence story)
    var r = new XMLHttpRequest();
    r.open('POST', url, true);
    r.setRequestHeader('Content-Type', 'application/json');
    r.onreadystatechange = makeXhrStateCallback(r,
      function postRetry() { /* TODO */ },
      function postDone(r) {
        if (opt_callback) opt_callback(r);
      });
    r.send(data);
    console.log(url, data);
  }
  network.xhrpost = xhrpost;
  
  function xhrdelete(url, opt_callback) {
    if (isDown) {
      queuedToRetry['DELETE ' + url] = function() { xhrdelete(url); };
      return;
    }
    var r = new XMLHttpRequest();
    r.open('DELETE', url, true);
    r.onreadystatechange = makeXhrStateCallback(r,
      function delRetry() {
        xhrdelete(url); // causes enqueueing
      },
      function delDone(r) {
        if (opt_callback) opt_callback(r);
      });
    r.send();
    console.log('DELETE', url);
  }
  network.xhrdelete = xhrdelete;
  
  function externalGet(url, responseType, callback) {
    var r = new XMLHttpRequest();
    r.responseType = responseType;
    r.onreadystatechange = function() {
      if (r.readyState === 4) {
        if (Math.floor(r.status / 100) == 2) {
          callback(r.response);
        } else {
          //TODO error handling in UI
        }
      }
    };
    r.open('GET', url, true);
    r.send();
  }
  network.externalGet = externalGet;
  
  function ReadWriteCell(name, assumed, type) {
    Cell.call(this, type);
    var value = assumed;
    var remoteValue = assumed;
    var inhibit = 0;
    var resetTimeout = undefined;
    this.get = function() { return value; },
    this.set = function(newValue) {
      value = newValue;
      this.n.notify();
      inhibit = Date.now() + 1000;  // TODO adjust value to observed latency
      xhrput(name, JSON.stringify(newValue), function(r) {
        if (Math.floor(r.status / 100) !== 2) {
          // some error or something other than success; revert
          inhibit = 0;
          this._update(remoteValue);
        }
      }.bind(this));
    };
    this._update = function(newValue) {
      remoteValue = newValue;
      if (resetTimeout) clearTimeout(resetTimeout);
      resetTimeout = setTimeout(acceptFromNetwork, Math.max(0, inhibit - Date.now()));
    };
    var acceptFromNetwork = function() {
      value = remoteValue;
      this.n.notify();
    }.bind(this);
  }
  ReadWriteCell.prototype = Object.create(Cell.prototype, {constructor: {value: ReadWriteCell}});
  network.ReadWriteCell = ReadWriteCell;
  
  function ReadCell(name, /* initial */ value, type, transform) {
    Cell.call(this, type);
    
    this._update = function(data) {
      value = transform(data);
      this.n.notify();
    };
    
    this.get = function() {
      return value;
    };
  }
  ReadCell.prototype = Object.create(Cell.prototype, {constructor: {value: ReadCell}});
  network.ReadCell = ReadCell;
  
  function SpectrumCell(url) {
    var fft = new Float32Array(0);
    var swapbuf = new Float32Array(0);
    var VSIZE = Float32Array.BYTES_PER_ELEMENT;
    var centerFreq = NaN;
    
    function transform(json) {
      if (json === null) {
        // occurs when server is paused on load — TODO fix server so it always returns an array
        return fft;
      }
      centerFreq = json[0];
      var arrayFFT = json[1];

      var halfFFTSize = arrayFFT.length / 2;

      // adjust size if needed
      if (arrayFFT.length !== fft.length) {
        fft = new Float32Array(arrayFFT.length);
        swapbuf = new Float32Array(arrayFFT.length);
      }
      
      // swap first and second halves for drawing convenience so that center frequency is at halfFFTSize rather than 0
      swapbuf.set(arrayFFT);
      fft.set(swapbuf.subarray(0, halfFFTSize), halfFFTSize);
      fft.set(swapbuf.subarray(halfFFTSize, fft.length), 0);
      
      return fft;
    }
    
    ReadCell.call(this, url, fft, sdr.values.any, transform);
    
    this.getCenterFreq = function() {
      return centerFreq;
    };
  }
  SpectrumCell.prototype = Object.create(ReadCell.prototype, {constructor: {value: SpectrumCell}});
  network.SpectrumCell = SpectrumCell;
  
  function setNonEnum(o, p, v) {
    Object.defineProperty(o, p, {
      value: v,
      configurable: true
    })
  }
  
  function buildFromDesc(url, desc) {
    switch (desc.kind) {
      case 'value':
        if (desc.type === 'spectrum') {
          // TODO eliminate special case
          return new SpectrumCell(url);
        } else if (desc.writable) {
          return new ReadWriteCell(url, desc.current, typeFromDesc(desc.type));
        } else {
          return new ReadCell(url, desc.current, typeFromDesc(desc.type), function (x) { return x; });
        }
      case 'block':
        var sub = {};
        setNonEnum(sub, '_url', url); // TODO kludge
        setNonEnum(sub, '_deathNotice', new sdr.events.Notifier());
        setNonEnum(sub, '_reshapeNotice', new sdr.events.Notifier());
        for (var k in desc.children) {
          // TODO: URL should come from server instead of being constructed here
          sub[k] = buildFromDesc(url + '/' + encodeURIComponent(k), desc.children[k]);
        }
        setNonEnum(sub, 'create', function(desc) {
          // TODO arrange a callback with the resulting _object_
          xhrpost(url, JSON.stringify(desc));
        });
        setNonEnum(sub, 'delete', function(key) {
          xhrdelete(url + '/' + encodeURIComponent(key));
        });
        return sub;
      default:
        console.error(url + ': Unknown kind ' + desc.kind + ' in', desc);
        return {};
    }
  }
  
  function openWebSocket(path) {
    // TODO: Have server deliver websocket URL, remove port number requirement
    if (!/^\//.test(path)) throw new Error('bad path');
    var secure = document.location.scheme === 'http' ? '' : 's';
    var ws = new WebSocket('ws' + secure + '://' + document.location.hostname + ':' + (parseInt(document.location.port) + 1) + document.location.pathname.replace(/\/$/, '') + path);
    ws.addEventListener('open', function (event) {
      ws.send(''); // dummy required due to server limitation
    }, true);
    return ws;
  }
  network.openWebSocket = openWebSocket;
  
  function connect(rootURL, callback) {
    var cellTree;
    
    externalGet(rootURL, 'text', function(text) {
      var desc = JSON.parse(text);
      cellTree = buildFromDesc(rootURL, desc);
      console.log(cellTree);

      // WebSocket state streaming
      var ws;
      function openWS() {
        ws = openWebSocket('/state');
        ws.onmessage = function(event) {
          function go(local, updates) {
            for (var key in updates) {
              var lobj = local[key];
              var updateItem = updates[key];
              if (lobj instanceof Cell) {
                lobj._update(updateItem); // TODO use parallel write facet structure instead
              } else if ('kind' in updateItem) {
                if (updateItem.kind === 'block') {
                  // TODO: Explicitly inactivate all cells in the old structure
                  if (lobj) {  // absent if this is a new block
                    lobj._deathNotice.notify();
                  } else {
                    // reshape notification is only when the key set changes
                    local._reshapeNotice.notify();
                  }
                  // TODO: avoid url construction
                  local[key] = buildFromDesc(local._url + '/' + encodeURIComponent(key), updateItem);
                } else if (updateItem.kind === 'block_updates') {
                  if (lobj) {
                    go(lobj, updateItem.updates);
                  } else {
                    console.error("Got updates for block we don't have: " + key);
                  }
                } else if (updateItem.kind === 'block_delete') {
                  if (lobj) {
                    lobj._deathNotice.notify();
                  }
                  delete local[key];
                  local._reshapeNotice.notify();
                } else {
                  console.error("Don't know what to do with update structure ", updateItem);
                }
              } else {
                console.error("Don't know what to do with update structure ", updateItem);
              }
            }
          }
          go(cellTree, JSON.parse(event.data));
        };
        ws.onclose = function() {
          console.error('Lost WebSocket connection');
          setTimeout(openWS, 1000);
        };
      }
      openWS();

      callback(cellTree);
    });
  }
  network.connect = connect;
  
  Object.freeze(network);
}());