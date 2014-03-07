# corral

Add, remove and update cloud-hosted packages defined in html markup

## Usage

Take existing markup and add a package (and its dependencies).

```javascript
var corral = require("corral")
  , markup = "<!DOCTYPE html> <html> ... </html>";

// Create a corral file instance by passing in the packageFetcher function
var file = corral(function(packageName, callback) {
  // This example assumes Angular.js setting, however any mechanism can be used to fetch a package
  // The only requirement is that the returned object meets the format requirements defined below
  $http.get("http://api.plnkr.co/catalogue/packages/" + packageName).then(function (response) {
    callback(null, response.data);
  }, function (err) {
    callback(err);
  });
});

// Overwrite the current bare-bones markup with your own custom html file's markup
// If you just want to build a 'new' file, no need to call write()
file.write(markup);

// Asynchronous methods of corral return Promises/A+ complian promises
file.addDependency("ui-bootstrap").then(function () {
  console.log("Updated markup", file.toString());
});
```

## API

#### *corral* (packageLoader)

Creates a `MarkupFile` instance that resolves packages based on the `packageLoader` callback described above.

#### *MarkupFile#write* (markup)

Resets the `MarkupFile` dependency graph and sets the initial html markup to `markup`.

#### *MarkupFile#addDependency* (packageRef)

Adds (or updates to the indicated version) a package and all its dependencies.

Where `packageRef` is a package reference in the format <packageName>[@<semverRange>].

Returns a promise that resolves to the `MarkupFile` object.

#### *MarkupFile#toString*()

Serializes the `MarkupFile` back to textual HTML.


## HTML annotations recognized

Corral recognizes `data-require` and `data-semver` annotations on `script` and `link[rel=stylesheet]` tags. These are used to identify the required package (and version range) and the current version of the package, respectively.

#### **`data-require`** (*required*)

Example:
```html
<script data-require="angular.js@1.2.x"></script>
```

This indicates that corral should replace that script tag with the best matching version of Angular.js that satisfies the 1.2.x semver constraint.

#### **`data-semver`** (*optional, added automatically by corral*)

Indicates the current version of the script/stylesheet of the current tag. This is only for bookkeeping purposes and is not required to be in the markup for corral to function.


## Package definition format

The package data response from the `packageLoader` passed into the corral constructor must conform to the following schema:

```javascript
{
  "name": "name-of-package",
  "versions": [
    {
      "semver": "0.0.0", // Must be a valid semver
      "styles": [
        "http://host.of/style1.css" // You can have any number of styles
      ],
      "scripts": [
        "http://host.of/script1.js" // You can have any number of scripts
      ],
      "dependencies": [
        "package1@5.x",
        "package2@^0.0.2"
      ]
    }
  ]
}
```

## Roadmap

* Add support for `link[rel=import]` tags for Polymer support

## Credits

* @simpulton for the fantastic name and for constant good ideas
