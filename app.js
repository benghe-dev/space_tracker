Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJmYzY2MDg0Yi1mMzM4LTRkMTAtYWQ1NS1hMGE4NDU3NmZmM2EiLCJpZCI6NDI1NzYyLCJpYXQiOjE3Nzc1NTI5MDF9.tHqMv5WVu4mVZQhPYdJdq-_9kFCCDjW0R915wwYgOQ0';

const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain(),
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    selectionIndicator: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false
});

viewer.clock.shouldAnimate = true;
viewer.clock.multiplier = 1;
viewer.scene.globe.enableLighting = true;
viewer.scene.globe.dynamicAtmosphereLighting = true;
viewer.scene.globe.depthTestAgainstTerrain = true;

viewer.scene.screenSpaceCameraController.maximumZoomDistance = 50000000;
viewer.scene.screenSpaceCameraController.minimumZoomDistance = 100;

const CATEGORY_URLS = {
    stations: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    visual: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=visual&FORMAT=tle',
    gps: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=gps-ops&FORMAT=tle'
};
const DEFAULT_CATEGORY = 'stations';
const EARTH_RADIUS_M = 6371000;
const NUM_SEGMENTS = 12;
const MIN_ALPHA = 0.05;

let orbitsToPreview = 1;

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
const telLos = document.getElementById('tel-los');
const satelliteSelector = document.getElementById('satellite-selector');
const categoryButtons = document.querySelectorAll('#category-panel .cat-btn');
const satSearchInput = document.getElementById('sat-search');
const cameraLockBtn = document.getElementById('camera-lock-btn');
const orbitSlider = document.getElementById('orbit-slider');
const orbitSliderValue = document.getElementById('orbit-slider-value');

let groundStationGd = null;
let groundStationCartesian = null;
let groundStationEntity = null;
let isCameraLocked = false;
let currentSearchQuery = '';

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

const losLineEntity = viewer.entities.add({
    name: 'LOS',
    polyline: {
        positions: new Cesium.CallbackProperty((time) => {
            if (!groundStationCartesian || !satEntity.position) return [];
            const satPos = satEntity.position.getValue(time);
            if (!satPos) return [];
            return [groundStationCartesian, satPos];
        }, false),
        width: 2,
        material: Cesium.Color.LIME.withAlpha(0.85),
        arcType: Cesium.ArcType.NONE,
        show: false
    }
});

function computeFootprintRadius(time) {
    if (!footprintEntity || !footprintEntity.position) return 1;
    const pos = footprintEntity.position.getValue(time);
    if (!pos) return 1;
    const cartographic = Cesium.Cartographic.fromCartesian(pos);
    if (!cartographic) return 1;
    const altitude = cartographic.height;
    if (!Number.isFinite(altitude) || altitude <= 0) return 1;
    const ratio = EARTH_RADIUS_M / (EARTH_RADIUS_M + altitude);
    if (ratio >= 1 || ratio <= -1) return 1;
    return EARTH_RADIUS_M * Math.acos(ratio);
}

const footprintEntity = viewer.entities.add({
    id: 'global-footprint',
    position: undefined,
    show: false,
    ellipse: {
        semiMajorAxis: new Cesium.CallbackProperty(computeFootprintRadius, false),
        semiMinorAxis: new Cesium.CallbackProperty(computeFootprintRadius, false),
        material: Cesium.Color.CYAN.withAlpha(0.15),
        outline: true,
        outlineColor: Cesium.Color.CYAN,
        height: 100000,
        granularity: Cesium.Math.RADIANS_PER_DEGREE / 2
    }
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

function buildSegmentPositions(satrec, direction, segIdx, nowMs, minPerSegment, stepMin) {
    const startMin = direction * segIdx * minPerSegment;
    const endMin = direction * (segIdx + 1) * minPerSegment;
    const positions = [];
    const step = direction * stepMin;

    let t = startMin;
    while ((direction > 0 && t < endMin) || (direction < 0 && t > endMin)) {
        const pos = propagateToCartesian(satrec, new Date(nowMs + t * 60000));
        if (pos) positions.push(pos);
        t += step;
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

    const periodMinutes = (2 * Math.PI) / currentSatrec.no;
    if (!Number.isFinite(periodMinutes) || periodMinutes <= 0) return;

    const totalMinutes = periodMinutes * orbitsToPreview;
    const stepSize = Math.max(1, Math.min(Math.round(totalMinutes / 1000), 4));
    const minPerSegment = totalMinutes / NUM_SEGMENTS;

    for (let i = 0; i < NUM_SEGMENTS; i++) {
        futureSegmentPositions[i] = buildSegmentPositions(currentSatrec, 1, i, nowMs, minPerSegment, stepSize);
        pastSegmentPositions[i] = buildSegmentPositions(currentSatrec, -1, i, nowMs, minPerSegment, stepSize);
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

function updateLOS(positionEci, gmst) {
    if (!groundStationGd) return;
    try {
        const positionEcf = satellite.eciToEcf(positionEci, gmst);
        const lookAngles = satellite.ecfToLookAngles(groundStationGd, positionEcf);
        const elevationDeg = lookAngles.elevation * 180 / Math.PI;

        if (lookAngles.elevation > 0) {
            losLineEntity.polyline.show = true;
            telLos.textContent = `ACQUIRED ${elevationDeg.toFixed(1)}°`;
            telLos.className = 'value los-acquired';
        } else {
            losLineEntity.polyline.show = false;
            telLos.textContent = 'BLOCKED';
            telLos.className = 'value los-blocked';
        }
    } catch (err) {
        losLineEntity.polyline.show = false;
        telLos.textContent = 'ERROR';
        telLos.className = 'value los-blocked';
    }
}

function updateRealtimeSample() {
    if (!currentSatrec) {
        footprintEntity.show = false;
        return;
    }

    const now = new Date();
    const positionAndVelocity = satellite.propagate(currentSatrec, now);
    if (!positionAndVelocity.position || !positionAndVelocity.velocity) return;

    const gmst = satellite.gstime(now);
    const geodetic = satellite.eciToGeodetic(positionAndVelocity.position, gmst);

    const cartesianPosition = Cesium.Cartesian3.fromRadians(
        geodetic.longitude,
        geodetic.latitude,
        geodetic.height * 1000
    );

    satEntity.position = cartesianPosition;
    footprintEntity.position = cartesianPosition;

    const v = positionAndVelocity.velocity;
    const speedKmS = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const speedKmH = Math.round(speedKmS * 3600);

    telLat.textContent = (geodetic.latitude * 180 / Math.PI).toFixed(4);
    telLon.textContent = (geodetic.longitude * 180 / Math.PI).toFixed(4);
    telAlt.textContent = geodetic.height.toFixed(2);
    telVel.textContent = speedKmH.toLocaleString('en-US');

    updateLOS(positionAndVelocity.position, gmst);
}

function requestUserLocation() {
    if (!navigator.geolocation) {
        telLos.textContent = 'N/A';
        telLos.className = 'value los-na';
        return;
    }
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;
            const altKm = (pos.coords.altitude || 0) / 1000;

            groundStationGd = {
                longitude: lon * Math.PI / 180,
                latitude: lat * Math.PI / 180,
                height: altKm
            };
            groundStationCartesian = Cesium.Cartesian3.fromDegrees(lon, lat, 0);

            groundStationEntity = viewer.entities.add({
                name: 'Ground Station',
                position: groundStationCartesian,
                point: {
                    pixelSize: 9,
                    color: Cesium.Color.DODGERBLUE,
                    outlineColor: Cesium.Color.WHITE,
                    outlineWidth: 2
                },
                label: {
                    text: 'Ground Station',
                    font: '12px sans-serif',
                    pixelOffset: new Cesium.Cartesian2(0, -18),
                    fillColor: Cesium.Color.WHITE,
                    showBackground: true,
                    backgroundColor: new Cesium.Color(0, 0, 0, 0.6)
                }
            });

            console.log(`Ground station: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
        },
        (err) => {
            console.warn('Geolocation denied/unavailable:', err.message);
            telLos.textContent = 'N/A';
            telLos.className = 'value los-na';
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
}

function selectSatellite(index) {
    const entry = satelliteDatabase[index];
    if (!entry) return;

    currentSatIndex = index;
    currentSatrec = entry.satrec;
    currentSatName = entry.name;
    satEntity.label.text = entry.name;

    if (satelliteSelector.value !== String(index)) {
        const opt = satelliteSelector.querySelector(`option[value="${index}"]`);
        if (opt) satelliteSelector.value = String(index);
    }

    footprintEntity.show = true;

    updateRealtimeSample();
    updateOrbitLines();

    if (isCameraLocked && entry.entity) {
        viewer.trackedEntity = entry.entity;
        return;
    }

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

function populateSelector(filterQuery = currentSearchQuery) {
    const q = (filterQuery || '').trim().toLowerCase();
    satelliteSelector.innerHTML = '';

    let matchCount = 0;
    satelliteDatabase.forEach((sat, idx) => {
        if (q && !sat.name.toLowerCase().includes(q)) return;
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = sat.name;
        satelliteSelector.appendChild(opt);
        matchCount++;
    });

    if (matchCount === 0) {
        const opt = document.createElement('option');
        opt.textContent = q ? 'No matches' : 'No satellites';
        opt.disabled = true;
        satelliteSelector.appendChild(opt);
        satelliteSelector.disabled = true;
        return;
    }

    satelliteSelector.disabled = false;

    if (currentSatIndex >= 0) {
        const matching = satelliteSelector.querySelector(`option[value="${currentSatIndex}"]`);
        if (matching) satelliteSelector.value = String(currentSatIndex);
    }
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
    footprintEntity.show = false;

    if (isCameraLocked) {
        viewer.trackedEntity = undefined;
        isCameraLocked = false;
        cameraLockBtn.textContent = 'LOCK CAMERA';
        cameraLockBtn.classList.remove('locked');
    }

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
    requestUserLocation();

    satelliteSelector.addEventListener('change', (e) => {
        const idx = parseInt(e.target.value, 10);
        if (Number.isFinite(idx)) selectSatellite(idx);
    });

    categoryButtons.forEach(btn => {
        btn.addEventListener('click', () => loadCategory(btn.dataset.category));
    });

    satSearchInput.addEventListener('input', (e) => {
        currentSearchQuery = e.target.value;
        populateSelector();
    });

    orbitSlider.addEventListener('input', () => {
        orbitsToPreview = parseInt(orbitSlider.value, 10) || 1;
        orbitSliderValue.textContent = orbitsToPreview === 1
            ? '1 Orbit'
            : `${orbitsToPreview} Orbits`;
        updateOrbitLines();
    });

    cameraLockBtn.addEventListener('click', () => {
        if (!isCameraLocked) {
            const entry = satelliteDatabase[currentSatIndex];
            if (!entry || !entry.entity) return;
            viewer.trackedEntity = entry.entity;
            isCameraLocked = true;
            cameraLockBtn.textContent = 'UNLOCK CAMERA';
            cameraLockBtn.classList.add('locked');
        } else {
            viewer.trackedEntity = undefined;
            isCameraLocked = false;
            cameraLockBtn.textContent = 'LOCK CAMERA';
            cameraLockBtn.classList.remove('locked');
        }
    });

    await loadCategory(DEFAULT_CATEGORY);

    setInterval(() => {
        updateAllSatellitePositions();
        updateRealtimeSample();
        updateOrbitLines();
    }, 1000);
})();
