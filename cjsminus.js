//#region JSDoc Global Definitions
/**
 * Used to specify an API for one of the 2 regions in a ClassicJSMinus class.
 * @typedef {Object} ClassDefSurface
 * @property {Object} [ClassicM.PRIVATE] Used to specify members not visible
 * outside the functions of the class being defined via an instance of the
 * same class.
 * @property {Object} [ClassicM.PROTECTED] Used to specifiy members visible
 * only to the functions of the class being defined and its direct decendants
 * via an instance of a corresponding class.
 * @property {Object} [ClassicM.PUBLIC] Used to specify members always visible
 * via an instance of the corresponding class or its direct descendants.
 */

/**
 * Specifies the instance and static API regions of the class being defined.
 * @typedef {Object} ClassDef
 * @extends ClassDefSurface
 * @property {string} [ClassicM.CLASSNAME] Used to assign a name to the class
 * via its constructor function.
 * @property {string} [ClassicM.INHERITMODE] Used to specify an inheritance
 * constraint on the class. Can be one of (ClassicM.ABSTRACT, ClassicM.FINAL).
 * @property {ClassDefSurface} [ClassicM.STATIC] Used to specify the API of the
 * `static` region of the class being defined.
 */

 /**
  * Used to specify that there exists an initialization function that must be
  * run in order to determine the value that will be assigned to the relevant
  * property at the time of instantiation.
  * @typedef {Object} PlaceHolder
  * @ignore
  */

//#endregion JSDoc Global Definitions

//#region Module Global Variables
/**
 * Global map of created classes to their definitions
 * @var @ignore
 */ 
const classDefs = new WeakMap();
/**
 * Global map of placeholder objects to their
 * corresponding initialization functions.
 * @var @ignore
 */
const initFns = new WeakMap();
/**
 * Global map of known functions to owning classes. Used
 * to verify that a given function has valid access to non-public properties of
 * a given object.
 * @var @ignore
 */
const owners = new WeakMap();
/**
 * Global map of instances to private layer connection requests per class. Used
 * to ensure that a private layer is not disconnected too early.
 * @var @ignore
 */
const connections = new WeakMap();
//#endregion Module Global Variables

//#region Module Global Constants
const AccessLevels = {
    Private: Symbol("ClassicJSMinus::PRIVATE"),
    Protected: Symbol("ClassicJSMinus::PROTECTED"),
    Public: Symbol("ClassicJSMinus::PUBLIC"),
    Static: Symbol("ClassicJSMinus::STATIC")
};

const ClassConfigKeys = {
    ClassName: Symbol("ClassicJSMinus::CLASSNAME"),
    InheritMode: Symbol("ClassicJSMinus::INHERITMODE")
};

const ClassConstants = {
    CLASS: Symbol("ClassicJSMinus::CLASS"),
    ABSTRACT: Symbol("ClassicJSMinus::ABSTRACT"),
    FINAL: Symbol("ClassicJSMinus::FINAL")
};

const PLACEHOLDER = new Symbol("ClassicJSMinus::PLACEHOLDER");
const PRIVATE_LAYER = new Symbol("ClassicJSMinus::PRIVATE_LAYER");
const CLASS_ID = new Symbol("ClassicJSMinus::CLASS_ID");
//#endregion Module Global Constants

//#region Helper Functions
/**
 * Retrieves all own string and symbolic key names from the object.
 * @ignore
 * @param {Object} obj Source for list of all keys to retrieve.
 * @returns {Array} Every key owned by the object.
 */
function getAllKeys(obj) {
    return Object.getOwnPropertyNames(obj).concat(
        Object.getOwnPropertySymbols(obj)
    );
}

/**
 * Generates a stupidly long sequence of random numbers that is likely to never
 * appear as a function name for use as a function name that can be identified
 * in a stack trace. This allows the handler logic to definitively identify
 * whether or not the calling function has private access.
 * @ignore
 * @returns {String} The new function name.
 */
function makeFnName() { 
    function getBigRandom() { return parseInt(Math.random()*Number.MAX_SAFE_INTEGER); }
    return `_$${getBigRandom()}${getBigRandom()}${getBigRandom()}${getBigRandom()}$_`;
}

/**
 * Wraps fn with a uniquely identifiable function that ensures privileged
 * member functions can be identified.
 * @param {Function} fn - Target function to wrap
 * @param {Function|Object} owner - Constructor or prototype of the owning class.
 * @returns {Function} - uniquely named wrapper function
 */
function makePvtName(fn, owner) {
    let name = makeFnName();
    let retval = eval(`
        (function ${name}(...args) {
            let inst = proxyMap.get(this) || this;
            stack.push(${name});
            let retval = fn.apply(inst, args); 
            stack.pop();
            return retval;
        })
    `);

    Object.defineProperties(retval, {
        displayName: {
            value: `${fn.name} wrapper (as ${name})`
        },
        owner: {
            value: owner
        },
        bind: {
            configurable: true,
            writable: true,
            value: function bind(that, ...args) {
                that = that[TARGET] || that;
                return Function.prototype.bind.call(this, that, ...args);
            }
        },
        toString: {
            configurable: true, 
            writable: true,
            value: Function.prototype.toString.bind(fn)
        },
        length: {
            configurable: true,
            value: fn.length
        }
    });

    owners.set(retval, owner);
    return retval;
}

/**
 * Copies all own properties of src into dest.
 * @ignore
 * @param {Function} owner Constructor function of the owning class.
 * @param {Object} src Container whose properties will be copied.
 * @param {Object} dest Container to hold the copied properties.
 * @param {boolean=} isPvt Wraps all methods and accessor function if true.
 */
function clone(owner, dest, src, isPvt=false) {
    if (isPvt) {
        let keys = getAllKeys(src);

        for (let key of keys) {
            let desc = Object.getOwnPropertyDescriptor(src, key);

            if (desc.hasOwnProperty("value")) {
                if (typeof(desc.value) === "function") {
                    desc.value = makePvtName(desc.value, owner);
                }
            }
            else {
                if (desc.hasOwnProperty("get") && (typeof(desc.get) === "function")) {
                    desc.get = makePvtName(desc.get, owner);
                }
                if (desc.hasOwnProperty("set") && (typeof(desc.set) === "function")) {
                    desc.set = makePvtName(desc.set, owner);
                }
            }
            Object.defineProperty(dest, key, desc);
        }
    }
    else {
        Object.defineProperties(dest, Object.getOwnPropertyDescriptors(src));
    }
}
//#endregion Helper Functions

/**
 * Validates the data object and ensures that it meets the minimum requirements
 * to keep from causing errors in this code.
 * @ignore
 * @param {ClassDef} data The data to be adjusted. 
 */
function fixupData(data) {
    let retval = { [ClassicM.STATIC]: {} };
    let a = new Set([ClassicM.STATIC, ClassicM.PRIVATE, ClassicM.PROTECTED, ClassicM.PUBLIC]);
    let duplicates = new Set();

    function checkForDuplicates(obj) {
        let keys = getAllKeys(obj);
        for (let key of keys) {
            if (duplicates.has(key)) {
                throw new SyntaxError(`Class definition contains duplicate key name: ${key}`);
            }

            duplicates.add(key);
        }
    }

    retval[ClassicM.CLASSNAME] = data[ClassicM.CLASSNAME] || "ClassBase";
    retval[ClassicM.INHERITMODE] = [ClassicM.ABSTRACT, ClassicM.FINAL, void 0].includes(data[ClassicM.INHERITMODE]) 
        ? data[ClassicM.INHERITMODE]
        : void 0;

    a.forEach((entry) => {
        if (data.hasOwnProperty(entry)) {
            let item = data[entry];
            if (item && (typeof(item) !== "object")) {
                throw new TypeError(`Expected property "data.${entry}" to be an object.`);
            }
            checkForDuplicates(item);
            retval[entry] = item;
        }
        else {
            retval[entry] = void 0;
        }
    });

    a.delete(ClassicM.STATIC);
    duplicates.clear(); 
    if (retval[ClassicM.STATIC]) {
        a.forEach((entry) => {
            if (data[ClassicM.STATIC] && data[ClassicM.STATIC].hasOwnProperty(entry)) {
                let item = data[ClassicM.STATIC][entry];
                if (item && (typeof(item) !== "object")) {
                    throw new TypeError(`Expected property "data[ClassicM.STATIC].${entry}" to be an object.`);
                }
                checkForDuplicates(item)
                retval[entry] = item;
            }
            else {
                retval[ClassicM.STATIC][entry] = void 0;
            }
        });
    }
    return retval;
}

function validateAccess(obj, depth) {

}

/**
 * Attaches the private instance layer to the instance object if it isn't
 * already there.
 * @param {Object} obj Instance to receive the private layer.
 * @param {Symbol} id Identifier of the private layer to be atttached.
 */
function connect(obj, id) {
    if (!validateAccess(this, 1) || !connections.has(obj))
        throw new TypeError("Inaccessible");

    let instanceData = connections.get(obj);
    let prototype = Object.getPrototypeOf(obj);
    if (!(PVT_DATA in obj)) {
        Object.setPrototypeOf(obj, Obj.freeze({
            [PVT_DATA]: {
                count: 1,
                prototype
            },
            [id]: instanceData[id]
        }))
    }
    else if (typeof(obj[id]) !== "object") {
        obj[id] = instanceData[id]
        ++obj[PVT_DATA].count;
    }
}

/**
 * Disconnects the private data space from the instance.
 * @param {Object} obj The instance holding the private data space.
 * @param {Symbol|null} [id] The id of the class whose private data will be
 * disconnected. If null or undefined, all private data spaces will be 
 * disconnected unconditionally.
 */
function disconnect(obj, id) {
    if ([null, void 0].includes(id)) {
        Object.setPrototypeOf(obj, prototype);
    }
    else if (PVT_DATA in obj) {
        obj[id] = void 0;
        --obj[PVT_DATA].count;

        if (!obj[PVT_DATA].count) {
            Object.setPrototypeOf(obj, prototype);
        }
    }
}

/**
 * Creates the protected prototype layer used to define protected members on
 * descendant private layers
 * @param pvt
 */
function initProtectedPrototype(pvt, src, owner) {
    let retval = {};
    let keys = getAllKeys(src);

    function makeProtectedValueGetter(key) {
        return function getProtectedValue() {
            let classId = this[ClassicM.CLASS][CLASS_ID];
            connect(this, classId);
            let retval = this[PVT_DATA][classId][key];
            disconnect(this, classId);
            return retval;
        }
    }

    function makeProtectedValueSetter(key) {
        return function setProtectedValue(value) {
            let classId = this[ClassicM.CLASS][CLASS_ID];
            connect(this, classId);
            let retval = this[PVT_DATA][classId][key] = value;
            disconnect(this, classId);
            return retval;
        }
    }

    clone(owner, pvt, src);
    for (let key of keys) {
        Object.defineProperty(retval, key, {
            enumerable: true,
            get: makeProtectedValueGetter(key),
            set: makeProtectedValueSetter(key)
        });
    }


    return retval;
}

function initPublicPrototype(pub, src, owner) {
}

function generatePrototypes(data, base, owner) {
    let retval = {};
    let pvt = {};

    let key = ClassicM.PRIVATE;
    if (data[key]) {
        retval[key] = clone(owner, pvt, data[key], true);
    }

    key = ClassicM.PROTECTED;
    if (data[key]) {
        retval[key] = initProtectedPrototype(pvt, data[key], owner);
    }
    if (data.hasOwnProperty(ClassicM.PUBLIC)) {
        retval[key] = initPublicPrototype(retval[key] || {}, data[key], owner);
    }
    if (key === ClassicM.STATIC) {
        retval[key] = generatePrototypes(data[key], base, owner);
    }

    return retval;
}

/**
 * Returns a new ClassicJSMinus class as defined by the `data` parmeter.
 * @param {function=} base The base class, if any. Defaults to `Object` if not specified
 * @param {ClassDef} data An object defining the new class structure.
 * @returns {function} The constructor of the newly created class.
 */
function ClassicM(base, data) {
    //Make sure we get reasonable parameters.
    switch (arguments.length) {
        case 0:
            base = Object;
            data = {};
            break;
        case 1: 
            switch (typeof(base)) {
                case "function":
                    data = {};
                    break;
                case "object":
                    data = base || {};
                    base = Object;
                    break;
                default:
                    throw new TypeError("Invalid argument.");
            }
            break;
        default:
            if (!typeof(base) === "function") {
                throw new TypeError("Parameter 'base' must be a constructor function or undefined.");
            }
            if (!(data && (typeof(data) === "object"))) {
                throw new TypeError("Parameter 'base' must be a constructor function or undefined.");
            }
            break;
    }

    //Make sure data is kosher.
    let definition = fixupData(data);

    if (classDefs.has(base) && (classDefs.get(base)[ClassicM.INHERITMODE] === Classic.FINAL)) {
        throw new TypeError("Cannot extend a final class.");
    }

    /**
     * Since we made it here, chances are good that the definition is ok. So we
     * need to build the constructor function, the private, protected, and
     * public prototypes, and store some metadata about the class and it's
     * known methods and properties.
     */
    let className = data[ClassicM.CLASSNAME] || ""; //Classes are allowed to be anonymous
    let newClass = eval(`()`);
    function /*${className}*/newClass(...args) {
        /**
         * We've got a bit of work to do to generate an instance. First, we
         * need to ensure we've got an instance object to work with.
         */
        if (!new.target) {
            throw new TypeError("Class constructor" + /*${className} +*/
                                " cannot be invoked without 'new'");
        }
        
        
    }

    Object.defineProperties(newClass, {
        [CLASS_ID]: Symbol(`${className}_ID`)
    });

    let prototypes = generatePrototypes(data, base, newClass);
    
    //#region ClassicM Static API
    Object.defineProperties(ClassicM, /** @lends ClassicM */{
        /**
         * Used to set the character used to access non-public 
         * class members. Must be either `_` or `$`.
         * @type {string}
         */
        PrivateAccessSpecifier: {
            enumerable: true,
            get() { return TRIGGER; },
            set(v) {
                if ((typeof(v) === "string") && (v.length === 1) &&
                    (["_", "$"].includes(v))) {
                    TRIGGER = v;
                }
                else {
                    throw new TypeError("Invalid private access specifier. Not altered.");
                }
            }
        },
        /**
         * Used to specify whether the class definition is organized using
         * strings or Symbol constants.
         * @type {boolean}
         */
        UseStrings: {
            enumerable: true,
            get() { return useStrings; },
            set(v) { useStrings = !!v; }
        },
        /**
         * Used to declare the static members in a class definition.
         * @type {string}
         * @readonly
         */
        STATIC: {
            enumerable: true,
            get() { return useStrings ? "static" : AccessLevels.Static; }
        },
        /**
         * Used to declare the private members in a class definition.
         * @type {string}
         * @readonly
         */
        PRIVATE: {
            enumerable: true,
            get() { return useStrings ? "private" : AccessLevels.Private; }
        },
        /**
         * Used to declare the protected members in a class definition.
         * @type {string}
         * @readonly
         */
        PROTECTED: {
            enumerable: true,
            get() { return useStrings ? "protected" : AccessLevels.Protected; }
        },
        /**
         * Used to declare the public members in a class definition.
         * @type {string}
         * @readonly
         */
        PUBLIC: {
            enumerable: true,
            get() { return useStrings ? "public" : AccessLevels.Public; }
        },
        /**
         * Used to declare the name of the new class in a class definition.
         * @type {string}
         * @readonly
         */
        CLASSNAME: {
            enumerable: true,
            get() { return useStrings ? "className" : ClassConfigKeys.ClassName; }
        },
        /**
         * Used to declare the inheritability of the new class in a class
         * definition. Used in conjunction with ClassicM.ABSTRACT and
         * ClassicM.Final.
         * @type {string}
         * @readonly
         */
        INHERITMODE: {
            enumerable: true,
            get() { return useStrings ? "inheritMode" : ClassConfigKeys.InheritMode; }
        },
        /**
         * Used to access the constructor function of the class given an
         * instance.
         * @type {string}
         * @readonly
         */
        CLASS: {
            enumerable: true,
            get() { return useStrings ? "cla$$" : ClassConstants.CLASS;}
        },
        /**
         * Used to specify the inheritance mode of the class via the class
         * definition. One of the constants that can be assigned to 
         * ClassicM.InheritMode. Specifies that the class **_must_** be
         * inherited to be used.
         * @type {string}
         * @readonly
         */
        ABSTRACT: {
            enumerable: true,
            get() { return useStrings ? "abstract" : ClassConstants.ABSTRACT; }
        },
        /**
         * Used to specify the inheritance mode of the class via the class
         * definition. One of the constants that can be assigned to 
         * ClassicM.InheritMode. Specifies that the class can **_never_** be
         * inherited.
         * @type {string}
         * @readonly
         */
        FINAL: {
            enumerable: true,
            get() { return useStrings ? "final" : ClassConstants.FINAL; }
        },
        /**
         * Used to set or alter a prototype member's initializer function.
         * @type {function}
         * @param {function} fn The new initializer function that will be used
         * on construction of an instance to initialize the corresponding
         * property.
         * @returns {PlaceHolder} A frozen object who's only purpose is to be a
         * value for a property who's actual value will be assigned during
         * construction of an instance of the class owning the property.
         */
        init: {
            enumerable: true,
            value: function init(fn) {
                if (typeof(fn) !== "function")
                    throw new TypeError("Init must be passed an initialization function!");
                let retval = Object.freeze({
                    [PLACEHOLDER]: { value: void 0 }
                });
                initFns.set(retval, fn);
                return retval;
            }
        },
        /**
         * Used to determine if the given value is a PlaceHolder which will be
         * replaced with a value from a corresponding initialization function.
         * @type {function}
         * @param {*} val The value to be tested.
         * @returns {boolean} Only returns `true` if the test passes.
         */
        isPlaceHolder: {
            enumerable: true,
            value: function isPlaceHolder(val) {
                return val && (typeof(val) === "object") &&
                    Object.isFrozen(val) &&
                    (Object.getOwnPropertyNames(val).length === 0) &&
                    (Object.getOwnPropertySymbols(val).length === 1) &&
                    val.hasOwnProperty(ClassicM.PLACEHOLDER) &&
                    (val[PLACEHOLDER] === void 0) &&
                    initFns.has(val);
            }
        },
        /**
         * Used to retrieve the initialization function corresponding to the
         * given placeholder object.
         * @type {function}
         * @param {Object} placeholder The placeholder who's function will be
         * retrieved.
         * @returns {function|undefined} The corresponding initialization
         * function or `undefined`.
         */
        getInitValue: {
            enumerable: true,
            value: function getInitValue(placeholder) {
                if (initFns.has(placeholder))
                    return initFns.get(placeholder)();
            }
        }
    }); 
    //#endregion ClassicM Static API
    
    module.exports = ClassicM;
}
