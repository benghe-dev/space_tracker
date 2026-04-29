Cesium.Ion.defaultAccessToken = '';

const viewer = new Cesium.Viewer('cesiumContainer', {
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(
        Promise.resolve(new Cesium.OpenStreetMapImageryProvider({
            url: 'https://a.tile.openstreetmap.org/'
        }))
    ),
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    selectionIndicator: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    terrainProvider: new Cesium.EllipsoidTerrainProvider()
});

viewer.clock.shouldAnimate = true;

const CATEGORY_URLS = {
    stations: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    visual: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',
    gps: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle'
};
const DEFAULT_CATEGORY = 'stations';
const ORBIT_WINDOW_MIN = 186;
const EARTH_RADIUS_M = 6371000;
const NUM_SEGMENTS = 12;
const MIN_PER_SEGMENT = ORBIT_WINDOW_MIN / NUM_SEGMENTS;
const MIN_ALPHA = 0.05;

let satelliteDatabase = [];
let currentSatrec = null;
let currentSatName = '';
let currentSatIndex = -1;

const futureSegmentPositions = Array.from({ length: NUM_SEGMENTS }, () => []);
const pastSegmentPositions = Array.from({ length: NUM_SEGMENTS }, () => []);
const futureLineEntities = [];
const pastLineEntities = [];

const telLat = document.getElementById('tel-lat');
const telLon = document.getElementById('tel-lon');
const telAlt = document.getElementById('tel-alt');
const telVel = document.getElementById('tel-vel');
const satelliteSelector = document.getElementById('satellite-selector');
const categoryButtons = document.querySelectorAll('#category-panel .cat-btn');

const satEntity = viewer.entities.add({
    name: 'Satellite',
    position: Cesium.Cartesian3.fromDegrees(10, 45, 400000),
    point: {
        pixelSize: 12,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2
    },
    label: {
        text: '',
        font: '14px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -20),
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.6)
    }
});

const footprintRadiusCallback = new Cesium.CallbackProperty((time) => {
    if (!satEntity || !satEntity.position) return 1;
    const pos = satEntity.position.getValue(time);
    if (!pos) return 1;
    const cartographic = Cesium.Cartographic.fromCartesian(pos);
    if (!cartographic) return 1;
    const altitude = cartographic.height;
    if (!Number.isFinite(altitude) || altitude <= 0) return 1;
    const ratio = EARTH_RADIUS_M / (EARTH_RADIUS_M + altitude);
    if (ratio >= 1 || ratio <= -1) return 1;
    return EARTH_RADIUS_M * Math.acos(ratio);
}, false);

satEntity.ellipse = new Cesium.EllipseGraphics({
    semiMinorAxis: footprintRadiusCallback,
    semiMajorAxis: footprintRadiusCallback,
    height: 0,
    fill: true,
    material: Cesium.Color.RED.withAlpha(0.15),
    outline: true,
    outlineColor: Cesium.Color.RED.withAlpha(0.8),
    outlineWidth: 2,
    show: false
});

function propagateToCartesian(satrec, time) {
    const pv = satellite.propagate(satrec, time);
    if (!pv.position) return null;
    const gmst = satellite.gstime(time);
    const geodetic = satellite.eciToGeodetic(pv.position, gmst);
    return Cesium.Cartesian3.fromRadians(
        geodetic.longitude,
        geodetic.latitude,
        geodetic.height * 1000
    );
}

function buildSegmentPositions(satrec, direction, segIdx, nowMs) {
    const startMin = direction * segIdx * MIN_PER_SEGMENT;
    const endMin = direction * (segIdx + 1) * MIN_PER_SEGMENT;
    const positions = [];

    let t = startMin;
    while ((direction > 0 && t < endMin) || (direction < 0 && t > endMin)) {
        const pos = propagateToCartesian(satrec, new Date(nowMs + t * 60000));
        if (pos) positions.push(pos);
        t += direction;
    }
    const endPos = propagateToCartesian(satrec, new Date(nowMs + endMin * 60000));
    if (endPos) positions.push(endPos);
    return positions;
}

function createOrbitEntities() {
    for (let i = 0; i < NUM_SEGMENTS; i++) {
        const alpha = Math.max(MIN_ALPHA, 1.0 - (i / NUM_SEGMENTS));
        const idx = i;

        futureLineEntities.push(viewer.entities.add({
            name: `Future ${i}`,
            polyline: {
                positions: new Cesium.CallbackProperty(
                    () => futureSegmentPositions[idx],
                    false
                ),
                width: 2,
                material: Cesium.Color.CYAN.withAlpha(alpha),
                arcType: Cesium.ArcType.NONE
            }
        }));

        pastLineEntities.push(viewer.entities.add({
            name: `Past ${i}`,
            polyline: {
                positions: new Cesium.CallbackProperty(
                    () => pastSegmentPositions[idx],
                    false
                ),
                width: 2,
                material: Cesium.Color.RED.withAlpha(alpha),
                arcType: Cesium.ArcType.NONE
            }
        }));
    }
}

function updateOrbitLines() {
    if (!currentSatrec) return;
    const nowMs = Date.now();
    for (let i = 0; i < NUM_SEGMENTS; i++) {
        futureSegmentPositions[i] = buildSegmentPositions(currentSatrec, 1, i, nowMs);
        pastSegmentPositions[i] = buildSegmentPositions(currentSatrec, -1, i, nowMs);
    }
}

function updateAllSatellitePositions() {
    const now = new Date();
    const gmst = satellite.gstime(now);

    for (let i = 0; i < satelliteDatabase.length; i++) {
        const sat = satelliteDatabase[i];
        if (!sat.entity || !sat.entity.show) continue;

        try {
            const pv = satellite.propagate(sat.satrec, now);
            if (!pv.position) continue;
            const geodetic = satellite.eciToGeodetic(pv.position, gmst);
            sat.entity.position = Cesium.Cartesian3.fromRadians(
                geodetic.longitude,
                geodetic.latitude,
                geodetic.height * 1000
            );
        } catch (err) {
            sat.entity.show = false;
        }
    }
}

function updateRealtimeSample() {
    if (!currentSatrec) return;

    const now = new Date();
    const positionAndVelocity = satellite.propagate(currentSatrec, now);
    if (!positionAndVelocity.position || !positionAndVelocity.velocity) return;

    const gmst = satellite.gstime(now);
    const geodetic = satellite.eciToGeodetic(positionAndVelocity.position, gmst);

    satEntity.position = Cesium.Cartesian3.fromRadians(
        geodetic.longitude,
        geodetic.latitude,
        geodetic.height * 1000
    );

    const v = positionAndVelocity.velocity;
    const speedKmS = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const speedKmH = Math.round(speedKmS * 3600);

    telLat.textContent = (geodetic.latitude * 180 / Math.PI).toFixed(4);
    telLon.textContent = (geodetic.longitude * 180 / Math.PI).toFixed(4);
    telAlt.textContent = geodetic.height.toFixed(2);
    telVel.textContent = speedKmH.toLocaleString('en-US');
}

function selectSatellite(index) {
    const entry = satelliteDatabase[index];
    if (!entry) return;

    satEntity.ellipse.show = true;

    currentSatIndex = index;
    currentSatrec = entry.satrec;
    currentSatName = entry.name;
    satEntity.label.text = entry.name;

    if (satelliteSelector.value !== String(index)) {
        satelliteSelector.value = String(index);
    }

    updateRealtimeSample();
    updateOrbitLines();

    const now = new Date();
    const pv = satellite.propagate(currentSatrec, now);
    if (pv.position) {
        const geodetic = satellite.eciToGeodetic(pv.position, satellite.gstime(now));
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromRadians(
                geodetic.longitude,
                geodetic.latitude,
                geodetic.height * 1000 * 10
            ),
            duration: 1.5
        });
    }
}

function populateSelector() {
    satelliteSelector.innerHTML = '';
    satelliteDatabase.forEach((sat, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = sat.name;
        satelliteSelector.appendChild(opt);
    });
    satelliteSelector.disabled = false;
}

function clearCurrentConstellation() {
    for (const sat of satelliteDatabase) {
        if (sat.entity) viewer.entities.remove(sat.entity);
    }
    satelliteDatabase = [];
    currentSatrec = null;
    currentSatName = '';
    currentSatIndex = -1;
    satEntity.label.text = '';
    satEntity.ellipse.show = false;

    for (let i = 0; i < NUM_SEGMENTS; i++) {
        futureSegmentPositions[i] = [];
        pastSegmentPositions[i] = [];
    }

    satelliteSelector.innerHTML = '';
    satelliteSelector.disabled = true;

    telLat.textContent = '--';
    telLon.textContent = '--';
    telAlt.textContent = '--';
    telVel.textContent = '--';
}

async function fetchSatelliteData(url) {
    clearCurrentConstellation();
    console.log(`Scaricamento dati orbitali da ${url} ...`);

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`TLE fetch failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);

    const db = [];
    for (let i = 0; i + 2 < lines.length; i += 3) {
        const name = lines[i].trim();
        const tle1 = lines[i + 1];
        const tle2 = lines[i + 2];
        if (!tle1.startsWith('1 ') || !tle2.startsWith('2 ')) continue;
        try {
            const satrec = satellite.twoline2satrec(tle1, tle2);
            db.push({ name, satrec });
        } catch (err) {
            console.warn(`Skipping malformed TLE for ${name}:`, err);
        }
    }

    if (db.length === 0) throw new Error('Nessun TLE valido nel feed');

    const now = new Date();
    const gmst = satellite.gstime(now);
    db.forEach((sat, idx) => {
        let initialPosition = Cesium.Cartesian3.fromDegrees(0, 0, 400000);
        try {
            const pv = satellite.propagate(sat.satrec, now);
            if (pv.position) {
                const geodetic = satellite.eciToGeodetic(pv.position, gmst);
                initialPosition = Cesium.Cartesian3.fromRadians(
                    geodetic.longitude,
                    geodetic.latitude,
                    geodetic.height * 1000
                );
            }
        } catch (err) { /* keep default position */ }

        const entity = viewer.entities.add({
            name: sat.name,
            position: initialPosition,
            point: {
                pixelSize: 3,
                color: Cesium.Color.WHITE.withAlpha(0.5),
                outlineWidth: 0
            }
        });
        entity.satIndex = idx;
        sat.entity = entity;
    });

    satelliteDatabase = db;
    populateSelector();
    selectSatellite(0);
    updateAllSatellitePositions();

    console.log(`Caricati ${satelliteDatabase.length} satelliti`);
}

async function loadCategory(categoryKey) {
    const url = CATEGORY_URLS[categoryKey];
    if (!url) return;

    categoryButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.toggle('active', btn.dataset.category === categoryKey);
    });

    try {
        await fetchSatelliteData(url);
    } catch (err) {
        console.error('Errore nel download dei dati orbitali:', err);
        satelliteSelector.innerHTML = '<option>Error loading data</option>';
    } finally {
        categoryButtons.forEach(btn => { btn.disabled = false; });
    }
}

function setupClickHandler() {
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction((click) => {
        const picked = viewer.scene.pick(click.position);
        if (Cesium.defined(picked) && picked.id && typeof picked.id.satIndex === 'number') {
            selectSatellite(picked.id.satIndex);
        }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

(async () => {
    createOrbitEntities();
    setupClickHandler();

    satelliteSelector.addEventListener('change', (e) => {
        selectSatellite(parseInt(e.target.value, 10));
    });

    categoryButtons.forEach(btn => {
        btn.addEventListener('click', () => loadCategory(btn.dataset.category));
    });

    await loadCategory(DEFAULT_CATEGORY);

    setInterval(() => {
        updateAllSatellitePositions();
        updateRealtimeSample();
        updateOrbitLines();
    }, 1000);
})();
