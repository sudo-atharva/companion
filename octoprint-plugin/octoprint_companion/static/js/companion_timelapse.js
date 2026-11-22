// Companion: change the timelapse watermark from OctoPrint's Timelapse tab.
$(function () {
    function CompanionTimelapseViewModel(parameters) {
        var self = this;
        var BASE = OctoPrint.getBlueprintUrl("companion");
        self.settings = parameters[0];
        self.loginState = parameters[1];
        self.stamp = ko.observable(Date.now());
        self.busy = ko.observable(false);
        self.message = ko.observable("");
        self.enabled = ko.observable(false);

        self.imageUrl = ko.pureComputed(function () {
            return BASE + "watermark.png?" + self.stamp(); // cache-buster: show the new image right away
        });
        self.canEdit = ko.pureComputed(function () {
            return self.loginState.hasPermission(self.loginState.access.permissions.SETTINGS);
        });

        self.onBeforeBinding = function () {
            self.enabled(self.settings.settings.webcam.watermark());
        };

        self.onAfterBinding = function () {
            // generic templates land at the end of <body>; put this one at the top of the Timelapse tab
            $("#companion_timelapse_watermark").prependTo("#timelapse").show();
        };

        self.saveEnabled = function () {
            OctoPrint.settings.save({webcam: {watermark: self.enabled()}});
        };

        self.pick = function () {
            $("#companion_watermark_file").val("").trigger("click");
        };

        function send(body) {
            self.busy(true);
            self.message("");
            return OctoPrint.postJson(BASE + "watermark", body)
                .done(function () {
                    self.stamp(Date.now());
                })
                .fail(function (xhr) {
                    self.message("Failed: " + (xhr.responseText || xhr.statusText));
                })
                .always(function () {
                    self.busy(false);
                });
        }

        self.upload = function (data, event) {
            var file = event.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
                send({image: reader.result});
            };
            reader.readAsDataURL(file);
        };

        self.reset = function () {
            send({reset: true});
        };
    }

    OCTOPRINT_VIEWMODELS.push({
        construct: CompanionTimelapseViewModel,
        dependencies: ["settingsViewModel", "loginStateViewModel"],
        elements: ["#companion_timelapse_watermark"]
    });
});
