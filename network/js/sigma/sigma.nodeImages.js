(function () {
    "use strict";

    var MIN_IMAGE_RADIUS = 3;      // Minimum screen radius (px) to render a photo instead of a flat dot
    var MAX_CONCURRENT_LOADS = 10; // Bounded parallel image requests to external CDN

    var imageCache = {}; // url -> { img: HTMLImageElement|null, status: "queued"|"loading"|"loaded"|"error" }
    var loadQueue = [];
    var activeLoads = 0;

    function getNodeImageUrl(node) {
        if (!node || !node.attr) return null;
        if (node.attr.image) return node.attr.image;
        if (node.attr.attributes && node.attr.attributes.image) {
            return node.attr.attributes.image;
        }
        return null;
    }

    function attachNodeImagePlugin(core) {
        var plotter = core.plotter;
        var graph = core.graph;
        var nodeDom = core.domElements.nodes;
        var nodeCtx = nodeDom.getContext("2d");
        var labelDom = core.domElements.labels;
        var labelCtx = labelDom ? labelDom.getContext("2d") : null;
        var hoverCtx = core.domElements.hover.getContext("2d");
        var redrawTimer = null;
        var colorMode = "image"; // "image" | "color"

        function scheduleNodeLayerRedraw() {
            if (redrawTimer !== null) return;
            redrawTimer = window.setTimeout(function () {
                redrawTimer = null;
                if (!core.p || !core.p.lastNodes) return;
                nodeCtx.clearRect(0, 0, nodeDom.width, nodeDom.height);
                plotter.currentNodeIndex = 0;
                while (plotter.task_drawNode()) {}
                core.refresh();
            }, 120);
        }

        function redrawNodesNow() {
            if (!core.p || !core.p.lastNodes) return;
            nodeCtx.clearRect(0, 0, nodeDom.width, nodeDom.height);
            plotter.currentNodeIndex = 0;
            while (plotter.task_drawNode()) {}
            core.refresh();
        }

        core._nodeImageMode = {
            setMode: function (mode) {
                var next = mode === "color" ? "color" : "image";
                if (colorMode !== next) {
                    colorMode = next;
                    redrawNodesNow();
                }
            },
            getMode: function () {
                return colorMode;
            },
        };

        function pumpQueue() {
            while (activeLoads < MAX_CONCURRENT_LOADS && loadQueue.length > 0) {
                var url = loadQueue.shift();
                var entry = imageCache[url];
                if (!entry || entry.status !== "queued") continue;

                entry.status = "loading";
                activeLoads++;

                (function (targetUrl, cacheEntry) {
                    var img = new Image();
                    cacheEntry.img = img;

                    img.onload = function () {
                        activeLoads--;
                        cacheEntry.status = "loaded";
                        scheduleNodeLayerRedraw();
                        pumpQueue();
                    };

                    img.onerror = function () {
                        activeLoads--;
                        cacheEntry.status = "error";
                        pumpQueue();
                    };

                    img.src = targetUrl;
                })(url, entry);
            }
        }

        function requestImage(url) {
            if (!url) return null;
            var entry = imageCache[url];
            if (entry) {
                return entry.status === "loaded" ? entry.img : null;
            }
            imageCache[url] = { img: null, status: "queued" };
            loadQueue.push(url);
            pumpQueue();
            return null;
        }

        function drawCircularImageOrFallback(
            ctx,
            node,
            x,
            y,
            r,
            fallbackColor,
            borderColor,
            borderWidth
        ) {
            var isDimmed = !!(node.attr && node.attr.grey);
            var url = colorMode === "image" ? getNodeImageUrl(node) : null;
            var img = colorMode === "image" && r >= MIN_IMAGE_RADIUS ? requestImage(url) : null;

            ctx.save();
            if (isDimmed) {
                ctx.globalAlpha = 0.2;
            }

            if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
                ctx.beginPath();
                ctx.arc(x, y, r, 0, 2 * Math.PI, true);
                ctx.closePath();
                ctx.save();
                ctx.clip();

                var iw = img.naturalWidth;
                var ih = img.naturalHeight;
                var scale = Math.max((2 * r) / iw, (2 * r) / ih);
                var dw = iw * scale;
                var dh = ih * scale;
                ctx.drawImage(img, x - dw / 2, y - dh / 2, dw, dh);
                ctx.restore();
            } else {
                ctx.fillStyle = fallbackColor;
                ctx.beginPath();
                ctx.arc(x, y, r, 0, 2 * Math.PI, true);
                ctx.closePath();
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(x, y, r, 0, 2 * Math.PI, true);
            if (borderWidth > 0) {
                ctx.strokeStyle = borderColor;
                ctx.lineWidth = borderWidth;
            } else if (colorMode === "color") {
                ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";
                ctx.lineWidth = Math.max(0.8, Math.min(1.6, r * 0.1));
            } else {
                ctx.strokeStyle = "rgba(255, 255, 255, 0.75)";
                ctx.lineWidth = Math.max(0.6, Math.min(1.5, r * 0.08));
            }
            ctx.stroke();

            ctx.restore();
        }

        plotter.task_drawNode = function () {
            var nodes = graph.nodes;
            var len = nodes.length;
            var count = 0;

            while (count++ < plotter.p.nodesSpeed && plotter.currentNodeIndex < len) {
                var node = nodes[plotter.currentNodeIndex++];
                if (!plotter.isOnScreen(node)) continue;

                var r = Math.max(1, Math.round(10 * node.displaySize) / 10);
                var color = node.color || plotter.p.defaultNodeColor;
                var lineWidth = node.attr && node.attr.lineWidth ? node.attr.lineWidth : 0;
                var strokeStyle = (node.attr && node.attr.strokeStyle) || "#ffffff";

                drawCircularImageOrFallback(
                    nodeCtx,
                    node,
                    node.displayX,
                    node.displayY,
                    r,
                    color,
                    strokeStyle,
                    lineWidth
                );

                if (node.hover) {
                    plotter.drawHoverNode(node);
                }
            }

            return plotter.currentNodeIndex < len;
        };

        function getLabelSize(node) {
            return plotter.p.labelSize === "fixed"
                ? plotter.p.defaultLabelSize
                : plotter.p.labelSizeRatio * node.displaySize;
        }

        function buildFontString(fontStyle, fontFamily, sizePx) {
            var parts = [];
            if (fontStyle) parts.push(String(fontStyle).trim());
            parts.push(sizePx + "px");
            parts.push(fontFamily || "Arial");
            return parts.join(" ");
        }

        function getLabelOffsetX(node) {
            return Math.max(node.displaySize + 6, 1.5 * node.displaySize);
        }

        // Override Sigma v0.1's label drawer to insert a space after fontStyle
        // (fixing the browser fallback to 10px) and keep alignment consistent with hover pills.
        if (labelCtx) {
            plotter.task_drawLabel = function () {
                var nodes = graph.nodes;
                var len = nodes.length;
                var count = 0;

                while (count++ < plotter.p.labelsSpeed && plotter.currentLabelIndex < len) {
                    var node = nodes[plotter.currentLabelIndex++];
                    if (!plotter.isOnScreen(node)) continue;

                    if (node.displaySize >= plotter.p.labelThreshold || node.forceLabel) {
                        var labelSize = getLabelSize(node);
                        var isDimmed = !!(node.attr && node.attr.grey);
                        var textX = Math.round(node.displayX + getLabelOffsetX(node));
                        var textY = Math.round(node.displayY);

                        labelCtx.save();
                        if (isDimmed) {
                            labelCtx.globalAlpha = 0.2;
                        }
                        labelCtx.font = buildFontString(
                            plotter.p.fontStyle,
                            plotter.p.font || "Arial",
                            labelSize
                        );
                        labelCtx.textBaseline = "middle";
                        labelCtx.lineJoin = "round";
                        labelCtx.lineWidth = Math.max(3, Math.round(labelSize * 0.2));
                        labelCtx.strokeStyle = "rgba(0, 0, 0, 0.85)";
                        labelCtx.strokeText(node.label, textX, textY);
                        labelCtx.fillStyle =
                            plotter.p.labelColor === "node"
                                ? node.color || plotter.p.defaultNodeColor
                                : plotter.p.defaultLabelColor;
                        labelCtx.fillText(node.label, textX, textY);
                        labelCtx.restore();
                    }
                }

                return plotter.currentLabelIndex < len;
            };
        }

        function drawHighlightedNode(node, isActive) {
            if (!plotter.isOnScreen(node)) return plotter;

            var labelSize = getLabelSize(node);
            var fontStyle = isActive
                ? plotter.p.activeFontStyle || plotter.p.fontStyle || ""
                : plotter.p.hoverFontStyle || plotter.p.fontStyle || "";
            var fontFamily = isActive
                ? plotter.p.activeFont || plotter.p.font || ""
                : plotter.p.hoverFont || plotter.p.font || "";
            var bgMode = isActive ? plotter.p.labelActiveBGColor : plotter.p.labelHoverBGColor;
            var defaultBG = isActive
                ? plotter.p.defaultActiveLabelBGColor
                : plotter.p.defaultHoverLabelBGColor;
            var hasShadow = isActive ? plotter.p.labelActiveShadow : plotter.p.labelHoverShadow;
            var shadowColor = isActive
                ? plotter.p.labelActiveShadowColor
                : plotter.p.labelHoverShadowColor;
            var nodeMode = isActive ? plotter.p.nodeActiveColor : plotter.p.nodeHoverColor;
            var defaultNodeClr = isActive
                ? plotter.p.defaultNodeActiveColor
                : plotter.p.defaultNodeHoverColor;
            var textMode = isActive ? plotter.p.labelActiveColor : plotter.p.labelHoverColor;
            var defaultTextClr = isActive
                ? plotter.p.defaultLabelActiveColor
                : plotter.p.defaultLabelHoverColor;

            hoverCtx.save();
            hoverCtx.font = buildFontString(fontStyle, fontFamily, labelSize);

            var textX = Math.round(node.displayX + getLabelOffsetX(node));
            var padY = 4;
            var pillX = Math.round(node.displayX - labelSize / 2 - padY);
            var pillY = Math.round(node.displayY - labelSize / 2 - padY);
            var pillH = Math.round(labelSize + padY * 2);
            var pillW = Math.round(textX - pillX + hoverCtx.measureText(node.label).width + 10);
            var pillR = Math.round(labelSize / 2 + padY);

            hoverCtx.fillStyle =
                bgMode === "node" ? node.color || plotter.p.defaultNodeColor : defaultBG;
            hoverCtx.beginPath();
            if (hasShadow) {
                hoverCtx.shadowOffsetX = 0;
                hoverCtx.shadowOffsetY = 0;
                hoverCtx.shadowBlur = 4;
                hoverCtx.shadowColor = shadowColor;
            }
            sigma.tools.drawRoundRect(hoverCtx, pillX, pillY, pillW, pillH, pillR, "left");
            hoverCtx.closePath();
            hoverCtx.fill();

            hoverCtx.shadowOffsetX = 0;
            hoverCtx.shadowOffsetY = 0;
            hoverCtx.shadowBlur = 0;

            var r = Math.max(1, node.displaySize);
            var borderColor =
                plotter.p.nodeBorderColor === "node"
                    ? node.color || plotter.p.defaultNodeColor
                    : plotter.p.defaultNodeBorderColor;
            var nodeFillColor =
                nodeMode === "node" ? node.color || plotter.p.defaultNodeColor : defaultNodeClr;

            drawCircularImageOrFallback(
                hoverCtx,
                node,
                Math.round(node.displayX),
                Math.round(node.displayY),
                r,
                nodeFillColor,
                borderColor,
                Math.max(isActive ? 2 : 1.5, plotter.p.borderSize || (isActive ? 2 : 1.5))
            );

            hoverCtx.fillStyle =
                textMode === "node" ? node.color || plotter.p.defaultNodeColor : defaultTextClr;
            hoverCtx.textBaseline = "middle";
            hoverCtx.fillText(node.label, textX, Math.round(node.displayY + 1));
            hoverCtx.restore();

            return plotter;
        }

        plotter.drawHoverNode = function (node) {
            return drawHighlightedNode(node, false);
        };

        plotter.drawActiveNode = function (node) {
            return drawHighlightedNode(node, true);
        };
    }

    sigma.addPlugin(
        "setNodeColorMode",
        function (mode) {
            if (this._core._nodeImageMode) {
                this._core._nodeImageMode.setMode(mode);
            }
            return this;
        },
        attachNodeImagePlugin
    );

    sigma.publicPrototype.getNodeColorMode = function () {
        return this._core._nodeImageMode ? this._core._nodeImageMode.getMode() : "image";
    };
})();
