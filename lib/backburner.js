import DeferredActionQueues from "backburner/deferred_action_queues";

var slice = [].slice,
    pop = [].pop,
    throttlers = [],
    debouncees = [],
    timers = [],
    autorun, laterTimer, laterTimerExpiresAt,
    global = this;

function Backburner(queueNames, options) {
  this.queueNames = queueNames;
  this.options = options || {};
  if (!this.options.defaultQueue) {
    this.options.defaultQueue = queueNames[0];
  }
  this.instanceStack = [];
}

Backburner.prototype = {
  queueNames: null,
  options: null,
  currentInstance: null,
  instanceStack: null,

  begin: function() {
    var onBegin = this.options && this.options.onBegin,
        previousInstance = this.currentInstance;

    if (previousInstance) {
      this.instanceStack.push(previousInstance);
    }

    this.currentInstance = new DeferredActionQueues(this.queueNames, this.options);
    if (onBegin) {
      onBegin(this.currentInstance, previousInstance);
    }
  },

  end: function() {
    var onEnd = this.options && this.options.onEnd,
        currentInstance = this.currentInstance,
        nextInstance = null;

    try {
      currentInstance.flush();
    } finally {
      this.currentInstance = null;

      if (this.instanceStack.length) {
        nextInstance = this.instanceStack.pop();
        this.currentInstance = nextInstance;
      }

      if (onEnd) {
        onEnd(currentInstance, nextInstance);
      }
    }
  },

  run: function(target, method /*, args */) {
    var ret;
    this.begin();

    if (!method) {
      method = target;
      target = null;
    }

    if (typeof method === 'string') {
      method = target[method];
    }

    // Prevent Safari double-finally.
    var finallyAlreadyCalled = false;
    try {
      if (arguments.length > 2) {
        ret = method.apply(target, slice.call(arguments, 2));
      } else {
        ret = method.call(target);
      }
    } finally {
      if (!finallyAlreadyCalled) {
        finallyAlreadyCalled = true;
        this.end();
      }
    }
    return ret;
  },

  defer: function(queueName, target, method /* , args */) {
    if (!method) {
      method = target;
      target = null;
    }

    if (typeof method === 'string') {
      method = target[method];
    }

    var stack = this.DEBUG ? new Error().stack : undefined,
        args = arguments.length > 3 ? slice.call(arguments, 3) : undefined;
    if (!this.currentInstance) { createAutorun(this); }
    return this.currentInstance.schedule(queueName, target, method, args, false, stack);
  },

  deferOnce: function(queueName, target, method /* , args */) {
    if (!method) {
      method = target;
      target = null;
    }

    if (typeof method === 'string') {
      method = target[method];
    }

    var stack = this.DEBUG ? new Error().stack : undefined,
        args = arguments.length > 3 ? slice.call(arguments, 3) : undefined;
    if (!this.currentInstance) { createAutorun(this); }
    return this.currentInstance.schedule(queueName, target, method, args, true, stack);
  },

  setTimeout: function() {
    var self = this,
        wait = pop.call(arguments),
        target = arguments[0],
        method = arguments[1],
        executeAt = (+new Date()) + wait;

    if (!method) {
      method = target;
      target = null;
    }

    if (typeof method === 'string') {
      method = target[method];
    }

    var fn, args;
    if (arguments.length > 2) {
      args = slice.call(arguments, 2);

      fn = function() {
        method.apply(target, args);
      };
    } else {
      fn = function() {
        method.call(target);
      };
    }

    // find position to insert - TODO: binary search
    var i, l;
    for (i = 0, l = timers.length; i < l; i += 2) {
      if (executeAt < timers[i]) { break; }
    }

    timers.splice(i, 0, executeAt, fn);

    if (laterTimer && laterTimerExpiresAt < executeAt) { return fn; }

    if (laterTimer) {
      clearTimeout(laterTimer);
      laterTimer = null;
    }
    laterTimer = global.setTimeout(function() {
      executeTimers(self);
      laterTimer = null;
      laterTimerExpiresAt = null;
    }, wait);
    laterTimerExpiresAt = executeAt;

    return fn;
  },

  throttle: function(target, method /* , args, wait */) {
    var self = this,
        args = arguments,
        wait = pop.call(args),
        throttler;

    for (var i = 0, l = throttlers.length; i < l; i++) {
      throttler = throttlers[i];
      if (throttler[0] === target && throttler[1] === method) { return; } // do nothing
    }

    var timer = global.setTimeout(function() {
      self.run.apply(self, args);

      // remove throttler
      var index = -1;
      for (var i = 0, l = throttlers.length; i < l; i++) {
        throttler = throttlers[i];
        if (throttler[0] === target && throttler[1] === method) {
          index = i;
          break;
        }
      }

      if (index > -1) { throttlers.splice(index, 1); }
    }, wait);

    throttlers.push([target, method, timer]);
  },

  debounce: function(target, method /* , args, wait, [immediate] */) {
    var self = this,
        args = arguments,
        immediate = pop.call(args),
        wait,
        index,
        debouncee;

    if (typeof immediate === "number") {
      wait = immediate;
      immediate = false;
    } else {
      wait = pop.call(args);
    }

    // Remove debouncee
    index = findDebouncee(target, method);

    if (index !== -1) {
      debouncee = debouncees[index];
      debouncees.splice(index, 1);
      clearTimeout(debouncee[2]);
    }

    var timer = global.setTimeout(function() {
      if (!immediate) {
        self.run.apply(self, args);
      }
      index = findDebouncee(target, method);
      if (index) {
        debouncees.splice(index, 1);
      }
    }, wait);

    if (immediate && index === -1) {
      self.run.apply(self, args);
    }

    debouncees.push([target, method, timer]);
  },

  cancelTimers: function() {
    var i, len;

    for (i = 0, len = throttlers.length; i < len; i++) {
      clearTimeout(throttlers[i][2]);
    }
    throttlers = [];

    for (i = 0, len = debouncees.length; i < len; i++) {
      clearTimeout(debouncees[i][2]);
    }
    debouncees = [];

    if (laterTimer) {
      clearTimeout(laterTimer);
      laterTimer = null;
    }
    timers = [];

    if (autorun) {
      clearTimeout(autorun);
      autorun = null;
    }
  },

  hasTimers: function() {
    return !!timers.length || autorun;
  },

  cancel: function(timer) {
    if (timer && typeof timer === 'object' && timer.queue && timer.method) { // we're cancelling a deferOnce
      return timer.queue.cancel(timer);
    } else if (typeof timer === 'function') { // we're cancelling a setTimeout
      for (var i = 0, l = timers.length; i < l; i += 2) {
        if (timers[i + 1] === timer) {
          timers.splice(i, 2); // remove the two elements
          return true;
        }
      }
    } else {
      return; // timer was null or not a timer
    }
  }
};

Backburner.prototype.schedule = Backburner.prototype.defer;
Backburner.prototype.scheduleOnce = Backburner.prototype.deferOnce;
Backburner.prototype.later = Backburner.prototype.setTimeout;

function createAutorun(backburner) {
  backburner.begin();
  autorun = global.setTimeout(function() {
    autorun = null;
    backburner.end();
  });
}

function executeTimers(self) {
  var now = +new Date(),
      time, fns, i, l;

  self.run(function() {
    // TODO: binary search
    for (i = 0, l = timers.length; i < l; i += 2) {
      time = timers[i];
      if (time > now) { break; }
    }

    fns = timers.splice(0, i);

    for (i = 1, l = fns.length; i < l; i += 2) {
      self.schedule(self.options.defaultQueue, null, fns[i]);
    }
  });

  if (timers.length) {
    laterTimer = global.setTimeout(function() {
      executeTimers(self);
      laterTimer = null;
      laterTimerExpiresAt = null;
    }, timers[0] - now);
    laterTimerExpiresAt = timers[0];
  }
}

function findDebouncee(target, method) {
  var debouncee,
      index = -1;

  for (var i = 0, l = debouncees.length; i < l; i++) {
    debouncee = debouncees[i];
    if (debouncee[0] === target && debouncee[1] === method) {
      index = i;
      break;
    }
  }

  return index;
}

export Backburner;
