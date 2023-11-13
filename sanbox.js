function isConstructor(fn) {
    // generator function and has own prototype properties
    const hasConstructor =
        fn.prototype &&
        fn.prototype.constructor === fn &&
        Object.getOwnPropertyNames(fn.prototype).length > 1;
    // unnecessary to call toString if it has constructor function
    const functionStr = !hasConstructor && fn.toString();
    const upperCaseRegex = /^function\s+[A-Z]/;

    return (
        hasConstructor ||
        // upper case
        upperCaseRegex.test(functionStr) ||
        // ES6 class, window function do not have this case
        functionStr.slice(0, 5) === 'class'
    );
}

// get function from original window, such as scrollTo, parseInt
function isWindowFunction(func) {
    return func && typeof func === 'function' && !isConstructor(func);
}
class Sandbox {
    sandbox;
    multiMode = false;
    eventListeners = {};
    timeoutIds = [];
    intervalIds = [];
    //存储在子应用运行时期间新增的全局变量，用于卸载子应用时还原主应用全局变量
    propertyAdded = {};
    //存储在子应用运行期间更新的全局变量，用于卸载子应用时还原主应用全局变量
    originalValues = {};
    sandboxDisabled;
    constructor(props = {}) {
        const { multiMode } = props;
        if (!window.Proxy) {
            console.warn('proxy sandbox is not support by current browser');
            this.sandboxDisabled = true;
        }
        // enable multiMode in case of create mulit sandbox in same time
        this.multiMode = multiMode;
        this.sandbox = null;
    }
    createProxySandbox(injection) {
        const { propertyAdded, originalValues, multiMode } = this;
        const proxyWindow = Object.create(null),
            originalWindow = window;
        const originalAddEventListener = window.addEventListener,
            originalRemoveEventListener = window.removeEventListener,
            originalSetInterval = window.setInterval,
            originalSetTimeout = window.setTimeout;
        // hijack addEventListener
        proxyWindow.addEventListener = (eventName, fn, ...rest) => {
            this.eventListeners[eventName] =
                this.eventListeners[eventName] || [];
            this.eventListeners[eventName].push(fn);
            return originalAddEventListener.apply(originalWindow, [
                eventName,
                fn,
                ...rest,
            ]);
        };
        // hijack removeEventListener
        proxyWindow.removeEventListener = (eventName, fn, ...rest) => {
            const listeners = this.eventListeners[eventName] || [];
            if (listeners.includes(fn)) {
                listeners.splice(listeners.indexOf(fn), 1);
            }
            return originalRemoveEventListener.apply(originalWindow, [
                eventName,
                fn,
                ...rest,
            ]);
        };
        // hijack setTimeout
        proxyWindow.setTimeout = (...args) => {
            const timerId = originalSetTimeout(...args);
            this.timeoutIds.push(timerId);
            return timerId;
        };
        // hijack setInterval
        proxyWindow.setInterval = (...args) => {
            const intervalId = originalSetInterval(...args);
            this.intervalIds.push(intervalId);
            return intervalId;
        };
        // 创建对proxyWindow的代理，proxyWindow就是我们传递给自执行函数的window对象
        const sandbox = new Proxy(proxyWindow, {
            set(target, prop, value) {
                if (!originalWindow.hasOwnProperty(prop)) {
                    // 如果window对象上没有这个属性，那么就在状态池中记录状态的新增；
                    propertyAdded[prop] = value;
                } else if (!originalValues.hasOwnProperty(prop)) {
                    //如果window对象上有这个p属性，并且originalValues没有这个p属性，
                    // 那么证明改属性是运行时期间更新的值，记录在状态池中用于最后window对象的还原
                    originalValues[prop] = originalWindow[prop];
                }
                // set new value to original window in case of jsonp, js bundle which will be execute outof sandbox
                if (!multiMode) {
                    originalWindow[prop] = value;
                }
                // eslint-disable-next-line no-param-reassign
                target[prop] = value;
                return true;
            },
            get(target, prop) {
                if (prop === Symbol.unscopables) {
                    return undefined;
                }
                if (['top', 'window', 'self', 'globalThis'].includes(prop)) {
                    return sandbox;
                }
                // proxy hasOwnProperty, in case of proxy.hasOwnProperty value represented as originalWindow.hasOwnProperty
                if (prop === 'hasOwnProperty') {
                    // eslint-disable-next-line no-prototype-builtins
                    return (key) =>
                        !!target[key] || originalWindow.hasOwnProperty(key);
                }
                const targetValue = target[prop];
                /**
                 * Falsy value like 0/ ''/ false should be trapped by proxy window.
                 */
                if (targetValue !== undefined) {
                    // case of addEventListener, removeEventListener, setTimeout, setInterval setted in sandbox
                    return targetValue;
                }

                // search from injection
                const injectionValue = injection && injection[prop];
                if (injectionValue) {
                    return injectionValue;
                }
                const value = originalWindow[prop];
                /**
                 * use `eval` indirectly if you bind it. And if eval code is not being evaluated by a direct call,
                 * then initialise the execution context as if it was a global execution context.
                 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/eval
                 * https://262.ecma-international.org/5.1/#sec-10.4.2
                 */
                if (prop === 'eval') {
                    return value;
                }
                if (isWindowFunction(value)) {
                    // When run into some window's functions, such as `console.table`,
                    // an illegal invocation exception is thrown.
                    const boundValue = value.bind(originalWindow);
                    // Axios, Moment, and other callable functions may have additional properties.
                    // Simply copy them into boundValue.
                    for (const key in value) {
                        boundValue[key] = value[key];
                    }
                    return boundValue;
                } else {
                    // case of window.clientWidth、new window.Object()
                    return value;
                }
            },
            has(target, prop) {
                return prop in target || prop in originalWindow;
            },
        });
        this.sandbox = sandbox;
    }
    getSandbox() {
        return this.sandbox;
    }
    getAddedProperties() {
        return this.propertyAdded;
    }
    // 再proxy中执行js
    execScriptInSandbox(script) {
        if (!this.sandboxDisabled) {
            // create sandbox before exec script
            if (!this.sandbox) {
                this.createProxySandbox();
            }
            try {
                const execScript = `with (sandbox) {;${script}\n}`;
                // eslint-disable-next-line no-new-func
                const code = new Function('sandbox', execScript).bind(
                    this.sandbox
                );
                // run code with sandbox
                code(this.sandbox);
            } catch (error) {
                console.error(
                    `error occurs when execute script in sandbox: ${error}`
                );
                throw error;
            }
        }
    }
    clear() {
        //子应用卸载还原
        if (!this.sandboxDisabled) {
            // remove event listeners
            Object.keys(this.eventListeners).forEach((eventName) => {
                (this.eventListeners[eventName] || []).forEach((listener) => {
                    window.removeEventListener(eventName, listener);
                });
            });
            // clear timeout
            this.timeoutIds.forEach((id) => window.clearTimeout(id));
            this.intervalIds.forEach((id) => window.clearInterval(id));
            // recover original values
            Object.keys(this.originalValues).forEach((key) => {
                window[key] = this.originalValues[key];
            });
            Object.keys(this.propertyAdded).forEach((key) => {
                delete window[key];
            });
        }
    }
}
window['sandboxCache'] = new Map();
