(function () {
    "use strict";

    var MIN_IMAGE_RADIUS = 5;      // Minimum screen radius (px) to render a photo instead of a flat dot
    var MAX_CONCURRENT_LOADS = 12; // Bounded parallel image requests to external CDN
    var REDRAW_INTERVAL_MS = 300;  // Coalesce async node-layer redraws while images stream in
    var SPRITE_SIZE = 256;         // Offscreen circular sprite cache size (px)

    var imageCache = {}; // url -> { img: HTMLImageElement|null, sprite: HTMLCanvasElement|null, status: "queued"|"loading"|"loaded"|"error" }
    var loadQueue = [];
    var activeLoads = 0;

    function buildCircularSprite(img) {
        if (typeof document === "undefined" || !img || !img.naturalWidth || !img.naturalHeight) {
            return null;
        }
        try {
            var canvas = document.createElement("canvas");
            canvas.width = SPRITE_SIZE;
            canvas.height = SPRITE_SIZE;
            var sctx = canvas.getContext && canvas.getContext("2d");
            if (!sctx) return null;

            var r = SPRITE_SIZE / 2;
            var iw = img.naturalWidth;
            var ih = img.naturalHeight;
            var scale = Math.max(SPRITE_SIZE / iw, SPRITE_SIZE / ih);
            var dw = iw * scale;
            var dh = ih * scale;

            sctx.beginPath();
            sctx.arc(r, r, r, 0, 2 * Math.PI, true);
            sctx.closePath();
            sctx.clip();
            sctx.drawImage(img, r - dw / 2, r - dh / 2, dw, dh);
            return canvas;
        } catch (err) {
            return null;
        }
    }

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
        var edgeDom = core.domElements.edges;
        var edgeCtx = edgeDom ? edgeDom.getContext("2d") : null;
        var labelDom = core.domElements.labels;
        var labelCtx = labelDom ? labelDom.getContext("2d") : null;
        var hoverCtx = core.domElements.hover.getContext("2d");
        var redrawTimer = null;
        var colorMode = "image"; // "image" | "color"
        var showLabels = false;

        function redrawNodesNow() {
            if (!core.p || !core.p.lastNodes) return;
            nodeCtx.clearRect(0, 0, nodeDom.width, nodeDom.height);
            plotter.currentNodeIndex = 0;
            while (plotter.task_drawNode()) {}
            core.refresh();
        }

        function redrawLabelsNow() {
            if (!labelCtx || !labelDom) return;
            labelCtx.clearRect(0, 0, labelDom.width, labelDom.height);
            if (!showLabels || !core.p || !core.p.lastLabels) return;
            plotter.currentLabelIndex = 0;
            while (plotter.task_drawLabel()) {}
        }

        function scheduleNodeLayerRedraw() {
            if (redrawTimer !== null) return;
            redrawTimer = window.setTimeout(function () {
                redrawTimer = null;
                if (typeof window.requestAnimationFrame === "function") {
                    window.requestAnimationFrame(redrawNodesNow);
                } else {
                    redrawNodesNow();
                }
            }, REDRAW_INTERVAL_MS);
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

        core._labelDisplayMode = {
            setVisible: function (visible) {
                var next = !!visible;
                if (showLabels !== next) {
                    showLabels = next;
                    redrawLabelsNow();
                }
            },
            isVisible: function () {
                return showLabels;
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
                        cacheEntry.sprite = buildCircularSprite(img);
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

        function requestImageEntry(url) {
            if (!url) return null;
            var entry = imageCache[url];
            if (entry) {
                return entry.status === "loaded" ? entry : null;
            }
            imageCache[url] = { img: null, sprite: null, status: "queued" };
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
            var entry = colorMode === "image" && r >= MIN_IMAGE_RADIUS ? requestImageEntry(url) : null;
            var sprite = entry ? entry.sprite : null;
            var img = entry ? entry.img : null;

            if (isDimmed) {
                ctx.save();
                ctx.globalAlpha = 0.2;
            }

            if (sprite) {
                ctx.drawImage(sprite, x - r, y - r, 2 * r, 2 * r);
            } else if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
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

            if (isDimmed) {
                ctx.restore();
            }
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
                if (!showLabels) {
                    plotter.currentLabelIndex = len;
                    return false;
                }
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

        // Batch visible edges by (color, quantized width, curve/line) to slash Canvas2D stroke() calls
        // and render straight lines on overview zoom (< 1.8x) while keeping curves when zoomed in.
        if (edgeCtx) {
            plotter.task_drawEdge = function () {
                var edges = graph.edges;
                var len = edges.length;
                var maxEdges = plotter.p.edgesSpeed || 200;
                var edgeColorMode = plotter.p.edgeColor;
                var defaultNodeColor = plotter.p.defaultNodeColor || "#aaa";
                var defaultEdgeColor = plotter.p.defaultEdgeColor || "#aaa";
                var defaultEdgeType = plotter.p.defaultEdgeType || "line";
                var ratio = core.mousecaptor && core.mousecaptor.ratio ? core.mousecaptor.ratio : 1;
                var allowCurve = ratio >= 1.8;

                var count = 0;
                var bucketOrder = [];
                var buckets = {};

                while (count++ < maxEdges && plotter.currentEdgeIndex < len) {
                    var edge = edges[plotter.currentEdgeIndex++];
                    var src = edge.source;
                    var dst = edge.target;
                    if (
                        edge.hidden ||
                        src.hidden ||
                        dst.hidden ||
                        (!plotter.isOnScreen(src) && !plotter.isOnScreen(dst))
                    ) {
                        continue;
                    }

                    var color = edge.color;
                    if (!color) {
                        if (edgeColorMode === "source") {
                            color = src.color || defaultNodeColor;
                        } else if (edgeColorMode === "target") {
                            color = dst.color || defaultNodeColor;
                        } else {
                            color = defaultEdgeColor;
                        }
                    }

                    var width = Math.max(0.25, Math.round(((edge.displaySize || 1) / 3) * 4) / 4);
                    var useCurve = allowCurve && (edge.type || defaultEdgeType) === "curve";
                    var key = color + "|" + width + "|" + (useCurve ? 1 : 0);
                    var bucket = buckets[key];
                    if (!bucket) {
                        bucket = {
                            color: color,
                            width: width,
                            curve: useCurve,
                            coords: [],
                        };
                        buckets[key] = bucket;
                        bucketOrder.push(bucket);
                    }
                    bucket.coords.push(src.displayX, src.displayY, dst.displayX, dst.displayY);
                }

                if (bucketOrder.length > 0) {
                    edgeCtx.save();
                    for (var bi = 0; bi < bucketOrder.length; bi++) {
                        var b = bucketOrder[bi];
                        var coords = b.coords;
                        edgeCtx.strokeStyle = b.color;
                        edgeCtx.lineWidth = b.width;
                        edgeCtx.beginPath();
                        if (b.curve) {
                            for (var ci = 0; ci < coords.length; ci += 4) {
                                var sx = coords[ci];
                                var sy = coords[ci + 1];
                                var tx = coords[ci + 2];
                                var ty = coords[ci + 3];
                                edgeCtx.moveTo(sx, sy);
                                edgeCtx.quadraticCurveTo(
                                    (sx + tx) / 2 + (ty - sy) / 4,
                                    (sy + ty) / 2 + (sx - tx) / 4,
                                    tx,
                                    ty
                                );
                            }
                        } else {
                            for (var li = 0; li < coords.length; li += 4) {
                                edgeCtx.moveTo(coords[li], coords[li + 1]);
                                edgeCtx.lineTo(coords[li + 2], coords[li + 3]);
                            }
                        }
                        edgeCtx.stroke();
                    }
                    edgeCtx.restore();
                }

                return plotter.currentEdgeIndex < len;
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

    sigma.publicPrototype.setLabelsVisible = function (visible) {
        if (this._core._labelDisplayMode) {
            this._core._labelDisplayMode.setVisible(visible);
        }
        return this;
    };

    sigma.publicPrototype.getLabelsVisible = function () {
        return this._core._labelDisplayMode ? this._core._labelDisplayMode.isVisible() : false;
    };
})();
