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
const AVIATION_URL = 'https://aerospace-tracker.benghe-web.workers.dev';
const AVIATION_REFRESH_MS = 15000;
const DEFAULT_CATEGORY = 'stations';

let currentDomain = 'SPACE';
let aviationUpdateInterval = null;
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
    currentSatName = entry.name;
    satEntity.label.text = entry.name;

    if (satelliteSelector.value !== String(index)) {
        const opt = satelliteSelector.querySelector(`option[value="${index}"]`);
        if (opt) satelliteSelector.value = String(index);
    }

    if (entry.isAircraft) {
        currentSatrec = null;
        satEntity.point.show = false;
        footprintEntity.show = false;
        losLineEntity.polyline.show = false;
        for (let i = 0; i < NUM_SEGMENTS; i++) {
            futureSegmentPositions[i] = [];
            pastSegmentPositions[i] = [];
        }
        updateAviationHUD(entry.metadata);

        if (isCameraLocked && entry.entity) {
            viewer.trackedEntity = entry.entity;
            return;
        }

        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(
                entry.metadata.longitude,
                entry.metadata.latitude,
                Math.max(entry.metadata.altitude * 12, 200000)
            ),
            duration: 1.5
        });
        return;
    }

    currentSatrec = entry.satrec;
    satEntity.point.show = true;
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
    if (aviationUpdateInterval) {
        clearInterval(aviationUpdateInterval);
        aviationUpdateInterval = null;
    }
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
    currentDomain = 'SPACE';
    satEntity.point.show = true;
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

function parseAviationState(state) {
    if (!state) return null;
    const longitude = state[5];
    const latitude = state[6];
    if (longitude == null || latitude == null) return null;
    return {
        icao24: state[0],
        callsign: state[1] ? state[1].trim() : 'UNKNOWN',
        longitude,
        latitude,
        altitude: state[13] || state[7] || 0,
        velocity: state[9] || 0,
        heading: state[10] || 0
    };
}

function createAviationEntity(plane) {
    return viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(plane.longitude, plane.latitude, plane.altitude),
        point: {
            pixelSize: 6,
            color: Cesium.Color.ORANGE,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1
        },
        label: {
            text: plane.callsign,
            font: '12px Rajdhani',
            fillColor: Cesium.Color.ORANGE,
            pixelOffset: new Cesium.Cartesian2(0, -15),
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 500000)
        }
    });
}

function updateAviationHUD(metadata) {
    if (!metadata) return;
    telLat.textContent = metadata.latitude.toFixed(4);
    telLon.textContent = metadata.longitude.toFixed(4);
    telAlt.textContent = (metadata.altitude / 1000).toFixed(2);
    telVel.textContent = Math.round(metadata.velocity * 3.6).toLocaleString('en-US');
    telLos.textContent = 'N/A';
    telLos.className = 'value los-na';
}

async function fetchAviationStates() {
    const response = await fetch(AVIATION_URL);
    if (!response.ok) {
        throw new Error(`OpenSky API Error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.states)) return [];
    return data.states.map(parseAviationState).filter(Boolean);
}

async function fetchAviationData() {
    clearCurrentConstellation();
    currentDomain = 'AVIATION';
    satEntity.point.show = false;
    satEntity.label.text = '';
    losLineEntity.polyline.show = false;
    footprintEntity.show = false;

    console.log('Scaricamento radar aviazione (OpenSky) ...');
    let planes;
    try {
        planes = await fetchAviationStates();
    } catch (err) {
        console.error('Aviation fetch failed:', err.message);
        satelliteSelector.innerHTML = '<option>Aviation feed unavailable</option>';
        satelliteSelector.disabled = true;
        return;
    }

    if (planes.length === 0) {
        console.warn('OpenSky returned no aircraft in current bounding box');
        satelliteSelector.innerHTML = '<option>No aircraft in feed</option>';
        satelliteSelector.disabled = true;
        return;
    }

    const db = planes.map((plane) => ({
        name: plane.callsign,
        isAircraft: true,
        icao24: plane.icao24,
        metadata: plane,
        entity: createAviationEntity(plane)
    }));
    db.forEach((sat, idx) => { sat.entity.satIndex = idx; });

    satelliteDatabase = db;
    populateSelector();
    selectSatellite(0);

    aviationUpdateInterval = setInterval(refreshAviationData, AVIATION_REFRESH_MS);
    console.log(`Caricati ${satelliteDatabase.length} aerei`);
}

async function refreshAviationData() {
    if (currentDomain !== 'AVIATION') return;
    let planes;
    try {
        planes = await fetchAviationStates();
    } catch (err) {
        console.warn('Aviation refresh failed:', err);
        return;
    }
    if (currentDomain !== 'AVIATION') return;

    const oldByIcao = new Map();
    satelliteDatabase.forEach(sat => {
        if (sat.isAircraft) oldByIcao.set(sat.icao24, sat);
    });
    const newIcaos = new Set(planes.map(p => p.icao24));
    const oldSelectedIcao = currentSatIndex >= 0 ? satelliteDatabase[currentSatIndex]?.icao24 : null;

    const updatedDb = [];
    for (const plane of planes) {
        const existing = oldByIcao.get(plane.icao24);
        if (existing) {
            existing.metadata = plane;
            existing.name = plane.callsign;
            existing.entity.position = Cesium.Cartesian3.fromDegrees(plane.longitude, plane.latitude, plane.altitude);
            if (existing.entity.label) existing.entity.label.text = plane.callsign;
            updatedDb.push(existing);
        } else {
            updatedDb.push({
                name: plane.callsign,
                isAircraft: true,
                icao24: plane.icao24,
                metadata: plane,
                entity: createAviationEntity(plane)
            });
        }
    }

    for (const sat of satelliteDatabase) {
        if (sat.isAircraft && !newIcaos.has(sat.icao24)) {
            viewer.entities.remove(sat.entity);
        }
    }

    updatedDb.forEach((sat, idx) => { sat.entity.satIndex = idx; });
    satelliteDatabase = updatedDb;

    const newIndex = oldSelectedIcao ? updatedDb.findIndex(s => s.icao24 === oldSelectedIcao) : -1;
    currentSatIndex = newIndex;
    populateSelector();

    if (newIndex >= 0) {
        satelliteSelector.value = String(newIndex);
        currentSatName = updatedDb[newIndex].name;
        satEntity.label.text = currentSatName;
        updateAviationHUD(updatedDb[newIndex].metadata);
    } else {
        currentSatName = '';
        satEntity.label.text = '';
        telLat.textContent = '--';
        telLon.textContent = '--';
        telAlt.textContent = '--';
        telVel.textContent = '--';
    }
}

async function loadCategory(categoryKey) {
    categoryButtons.forEach(btn => {
        btn.disabled = true;
        btn.classList.toggle('active', btn.dataset.category === categoryKey);
    });

    try {
        if (categoryKey === 'aviation') {
            await fetchAviationData();
        } else {
            const url = CATEGORY_URLS[categoryKey];
            if (!url) return;
            await fetchSatelliteData(url);
        }
    } catch (err) {
        console.error('Errore caricamento dataset:', err);
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
        if (currentDomain !== 'SPACE') return;
        updateAllSatellitePositions();
        updateRealtimeSample();
        updateOrbitLines();
    }, 1000);
})();
