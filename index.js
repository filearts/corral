var Semver = require("semver")
  , Promise = require("promise")
  , Cheerio = require("cheerio")
  , _ = require("lodash");

/**
 * An object representing an html file and its depdendencies
 * 
 * @param packageLoader Pass in a callback that will accept package name and callback parameters
 */
function MarkupFile (packageLoader) {
  if (!(this instanceof MarkupFile))
    return new MarkupFile(packageLoader);
  
  if (!_.isFunction(packageLoader)) throw new Error("MarkupFile must be passed a packageLoader callback at creation.");

  this.packageLoader = Promise.denodeify(packageLoader);
  this.markup = "";
  this.packages = {};
  this.dependencies = [];
  
  _.bindAll(this, "reset", "loadPackageDefinition", "loadPackageDependencies", "updateAllPackageTags", "loadPackageDefinitions", "toString", "toHTML");
  
  this.reset();
}

MarkupFile.prototype.reset = function (markup) {
  // We use a default markup with the basic elements of an html file
  if (!markup) markup = "<!DOCTYPE html>\n\n<html>\n\n<head>\n</head>\n\n<body>\n</body>\n\n</html>";
  
  this.packages = {};
  this.dependencies = [];
  this.markup = markup;
  
  this.$ = Cheerio.load(this.markup);
  
  return Promise.from(this);
};

MarkupFile.prototype.addDependency = function (pkgRef) {
  var self = this
    , parsedPkgRef = parsePackageRef(pkgRef);
  
  if (!parsedPkgRef) throw new Error("Unable to add invalid package reference: " + pkgRef);
  
  return this.loadPackageDefinition(parsedPkgRef.name, parsedPkgRef.range).then(function (pkgInst) {
    self.updatePackageTags(pkgInst, {updateChildren: true});
  });
};

MarkupFile.prototype.loadPackageDefinition = function (pkgName, pkgRange) {
  var pkgInst = this.getOrCreateDependency(pkgName)
    , self = this;
    
  // First check if the package has already been loaded in which case we will not
  // hit the server again
  if (pkgInst.loaded) {
    // pkgInst.loaded is the Promise tied to the original load of the package
    return pkgInst.loaded.then(function () {
      pkgInst.range = pkgRange;
      pkgInst.textRage = pkgRange.textRange;
      pkgInst.matchingVersions = _.filter(pkgInst.versions, function(verDef) {
        return pkgRange.test(verDef.semver);
      });
      
      return pkgInst;
    });
  } else {
    pkgInst.loaded = this.packageLoader(pkgName).then(function (pkgDef) {
      // Sort the package's versions according to semver
      pkgInst.versions = _(pkgDef.versions).sort(function (a, b) {
        return Semver.rcompare(a.semver, b.semver);
      }).value();
      
      // Filter out package versions that do not match the requested vesion range
      pkgInst.matchingVersions = _.filter(pkgInst.versions, function(verDef) {
        return pkgRange.test(verDef.semver);
      });
      
      // Check if any versions matched. If there are matching versions resolve dependencies
      if (pkgInst.matchingVersions.length) {
        return self.loadPackageDependencies(pkgInst, pkgInst.matchingVersions[0]).then(function () {
          // Check if the dependency is already in the dependencies array
          if (0 > self.dependencies.indexOf(pkgInst)) {
            var insertIndex = self.dependencies.length
              , minIndex = 0;

            for (var i = 0, len = pkgInst.parents.length; i < len; i++) {
              var parent = pkgInst.parents[i];
              
              if (0 <= (minIndex = self.dependencies.indexOf(parent))) {
                insertIndex = Math.min(insertIndex, minIndex);
              }
            }
            
            // Insert the package instance at the correct position in the dependencies array
            self.dependencies.splice(insertIndex, 0, pkgInst);
          }
        }).then(function () {
          // Now that dependencies are loaded, resolve the promise as the package instance
          return pkgInst;
        });
      }
      
      // No matching versions, resolve the promise as the package instance
      return pkgInst;
    });
    
    // Return the outer promise
    return pkgInst.loaded;
  }
};

/**
 * Recursively load all dependencies of a given package
 */
MarkupFile.prototype.loadPackageDependencies = function (parent, verDef) {
  var self = this
    , promises = [];
  
  if (!verDef) verDef = parent.matchingVersions[0];
  
  _.each(verDef.dependencies, function (depObj) {
    var depRef = parsePackageRef(depObj.name + "@" + (depObj.range || ""));
    
    if (depRef) {
      promises.push(self.loadPackageDefinition(depRef.name, depRef.range).then(function(pkgInst) {
        self.filter
        pkgInst = self.getOrCreateDependency(depRef.name, depRef);
        pkgInst.parents.push(parent);
        return parent.children.push(pkgInst);
      }));
    }
  });
  
  return Promise.all(promises).then(function () {
    return parent;
  });
};

MarkupFile.prototype.getOrCreateDependency = function (pkgName, options) {
  if (!options) options = {};
  
  if (!options.textRange) options.textRange = "*";
  if (!options.range) options.range = parseSemverRange(options.textRange);

  if (!this.packages[pkgName]) {
    this.packages[pkgName] = {
      name: pkgName,
      range: options.range,
      textRange: options.textRange,
      currentVersion: options.version,
      matchingVersions: [],
      versions: [],
      scripts: [],
      styles: [],
      children: [],
      parents: [],
      loaded: null
    };
  }
  
  return this.packages[pkgName];
};

/**
 * Update (and add missing) script and link tags to the underlying html file
 */
MarkupFile.prototype.updatePackageTags = function (pkgInstOrRef, options) {
  var self = this
    , scriptsInserted = false
    , stylesInserted = false
    , pkgInst;
  
  if (_.isString(pkgInstOrRef) && (pkgInstOrRef = parsePackageRef(pkgInstOrRef))) {
    pkgInst = this.packages[pkgInstOrRef.name];
  } else {
    pkgInst = pkgInstOrRef;
  }
  
  if (!options) options = {};
  
  if (!pkgInst) throw new Error("Unable to update invalid package instance");
  
  newScripts = createScriptTags(pkgInst);
  newStyles = createStyleTags(pkgInst);
  
  if (newScripts.length) {
    _ref = pkgInst.parents;
    for (_i = _ref.length - 1; _i >= 0; _i += -1) {
      parent = _ref[_i];
      if (parent.scripts.length) {
        beforeIndented(parent.scripts, newScripts);
        scriptsInserted = true;
        removeIndented(pkgInst.scripts);
        break;
      }
    }
    if (!scriptsInserted) {
      if (pkgInst.scripts.length) {
        beforeIndented(pkgInst.scripts, newScripts);
        removeIndented(pkgInst.scripts);
      } else if ((scripts = self.$("script[data-require]")).length) {
        afterIndented(scripts, newScripts);
      } else if ((scripts = self.$("head script")).length) {
        beforeIndented(scripts, newScripts);
      } else if ((children = self.$("head").children()).length) {
        afterIndented(children, newScripts);
      } else if (self.$("head").length) {
        appendIndented(self.$("head"), newScripts);
      } else {
        appendIndented(self.$._root, newScripts);
      }
    }
    pkgInst.scripts = newScripts;
  }
  
  if (newStyles.length) {
    _ref1 = pkgInst.parents;
    for (_j = _ref1.length - 1; _j >= 0; _j += -1) {
      parent = _ref1[_j];
      if (parent.styles.length) {
        beforeIndented(parent.styles, newStyles);
        stylesInserted = true;
        removeIndented(pkgInst.styles);
        break;
      }
    }
    if (!stylesInserted) {
      if (pkgInst.styles.length) {
        beforeIndented(pkgInst.styles, newStyles);
        removeIndented(pkgInst.styles);
      } else if ((styles = self.$("link[data-require]")).length) {
        afterIndented(styles, newStyles);
      } else if ((styles = self.$("head link[rel=stylesheet]")).length) {
        beforeIndented(styles, newStyles);
      } else if ((children = self.$("head").children()).length) {
        afterIndented(children, newStyles);
      } else if (self.$("head").length) {
        appendIndented(self.$("head"), newStyles);
      } else {
        appendIndented(self.$._root, newStyles);
      }
    }
    pkgInst.styles = newStyles;
  }
  
  if (options.updateChildren) {
    _ref2 = pkgInst.children;
    for (_k = 0, _len = _ref2.length; _k < _len; _k++) {
      child = _ref2[_k];
      this.updatePackageTags(child);
    }
  }
  
  
  function createScriptTags (pkgInst, version) {
    var $el, tags, url, _i, _len, _ref;
    if (version == null) {
      version = pkgInst.matchingVersions[0];
    }
    tags = [];
    if (version != null ? version.scripts : void 0) {
      _ref = version.scripts;
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        url = _ref[_i];
        $el = self.$("<script></script>");
        $el.attr("data-require", "" + pkgInst.name + "@" + pkgInst.textRange);
        $el.attr("data-semver", version.semver);
        $el.attr("src", url);
        tags.push($el[0]);
      }
    }
    return tags;
  }
  
  function createStyleTags (pkgInst, version) {
    var $el, tags, url, _i, _len, _ref;
    if (version == null) {
      version = pkgInst.matchingVersions[0];
    }
    tags = [];
    if (version != null ? version.styles : void 0) {
      _ref = version.styles;
      for (_i = 0, _len = _ref.length; _i < _len; _i++) {
        url = _ref[_i];
        $el = self.$("<link>");
        $el.attr("data-require", "" + pkgInst.name + "@" + pkgInst.textRange);
        $el.attr("data-semver", version.semver);
        $el.attr("rel", "stylesheet");
        $el.attr("href", url);
        tags.push($el[0]);
      }
    }
    return tags;
  }
  
  function beforeIndented (anchorEls, tags) {
    var anchor, indent, leadingText, prev, tag, _i, _len, _results;
    leadingText = "";
    if (anchor = anchorEls[0]) {
      prev = anchor.prev;
      while (prev && (prev.type === "text")) {
        leadingText = prev.data + leadingText;
        prev = prev.prev;
      }
      indent = "\n" + leadingText.split("\n").pop();
      _results = [];
      for (_i = 0, _len = tags.length; _i < _len; _i++) {
        tag = tags[_i];
        self.$(anchor).before(tag);
        _results.push(self.$(anchor).before(indent));
      }
      return _results;
    }
  }
  
  function afterIndented (anchorEls, tags) {
    var anchor, indent, leadingText, prev, tag, _i, _results;
    leadingText = "";
    if (anchor = anchorEls[anchorEls.length - 1]) {
      prev = anchor.prev;
      while (prev && (prev.type === "text")) {
        leadingText = prev.data + leadingText;
        prev = prev.prev;
      }
      indent = "\n" + leadingText.split("\n").pop();
      _results = [];
      for (_i = tags.length - 1; _i >= 0; _i += -1) {
        tag = tags[_i];
        self.$(anchor).after(tag);
        _results.push(self.$(anchor).after(indent));
      }
      return _results;
    }
  }
  
  function appendIndented (parent, tags, indent) {
    var tag, _i, _len;
    if (indent == null) {
      indent = "  ";
    }
    for (_i = 0, _len = tags.length; _i < _len; _i++) {
      tag = tags[_i];
      self.$(parent).append(tag).append("\n");
    }
    return self.$(tags).before(indent);
  }
  
  function removeIndented (tags) {
    var prev, tag, _i, _len;
    for (_i = 0, _len = tags.length; _i < _len; _i++) {
      tag = tags[_i];
      prev = tag.prev;
      while (prev && (prev.type === "text")) {
        self.$(prev).remove();
        prev = prev.prev;
      }
    }
    return self.$(tags).remove();
  }
};

MarkupFile.prototype.updateAllPackageTags = function() {
  var pkgInst, _i, _len, _ref;
  _ref = this.dependencies.reverse();
  for (_i = 0, _len = _ref.length; _i < _len; _i++) {
    pkgInst = _ref[_i];
    this.updatePackageTags(pkgInst);
  }
  return Promise.from(this);
};

MarkupFile.prototype.loadPackageDefinitions = function() {
  var file, promises;
  file = this;
  promises = [];
  _.each(this.packages, function(pkgInst, pkgName) {
    return promises.push(file.loadPackageDefinition(pkgName, pkgInst.range));
  });
  return Promise.all(promises).then(function() {
    return file.packages;
  });
};

MarkupFile.prototype.toString = function () {
  return this.$.html();
};

MarkupFile.prototype.toHTML = MarkupFile.prototype.toString;

/**
 * Parse a package reference of the form name@range
 * 
 * Returns undefined if the reference is invalid
 */
function parsePackageRef (pkgRef) {
  var parts = pkgRef.split("@")
    , name = parts.shift()
    , textRange = parts.shift() || "*"
    , semverRange = parseSemverRange(textRange);
  
  if (!name || !semverRange) return;

  return {
    name: name,
    textRange: textRange,
    range: semverRange
  };
}

/**
 * Parse a semver string into a Semver object
 * 
 * Returns undefined if the reference is invalid
 */
function parseSemver (semver) {
  if (!semver) semver = "*";
  
  try {
    return new Semver.Semver(semver);
  } catch (_error) {
    return;
  }
}

/**
 * Parse a semver range into a semver Range object
 * 
 * Returns undefined if the reference is invalid
 */
function parseSemverRange (semverRange) {
  if (!semverRange) semverRange = "*";
  
  try {
    return new Semver.Range(semverRange);
  } catch (_error) {
    return;
  }
}

module.exports = MarkupFile;