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

const TLE_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=tle';

let satrec = null;

const telLat = document.getElementById('tel-lat');
const telLon = document.getElementById('tel-lon');
const telAlt = document.getElementById('tel-alt');
const telVel = document.getElementById('tel-vel');

const issEntity = viewer.entities.add({
    name: 'ISS',
    position: Cesium.Cartesian3.fromDegrees(10, 45, 400000),
    point: {
        pixelSize: 12,
        color: Cesium.Color.RED,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2
    },
    label: {
        text: 'ISS',
        font: '14px sans-serif',
        pixelOffset: new Cesium.Cartesian2(0, -20),
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: new Cesium.Color(0, 0, 0, 0.6)
    }
});

function updateSatellitePosition() {
    if (!satrec) return;

    const now = new Date();
    const positionAndVelocity = satellite.propagate(satrec, now);

    if (!positionAndVelocity.position || !positionAndVelocity.velocity) {
        return;
    }

    const gmst = satellite.gstime(now);
    const geodetic = satellite.eciToGeodetic(positionAndVelocity.position, gmst);

    issEntity.position = Cesium.Cartesian3.fromRadians(
        geodetic.longitude,
        geodetic.latitude,
        geodetic.height * 1000
    );

    const v = positionAndVelocity.velocity;
    const speedKmS = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    const speedKmH = Math.round(speedKmS * 3600);

    const latDeg = (geodetic.latitude * 180 / Math.PI).toFixed(4);
    const lonDeg = (geodetic.longitude * 180 / Math.PI).toFixed(4);
    const altKm = geodetic.height.toFixed(2);

    telLat.textContent = latDeg;
    telLon.textContent = lonDeg;
    telAlt.textContent = altKm;
    telVel.textContent = speedKmH.toLocaleString('en-US');
}

async function fetchISSTle() {
    console.log('Scaricamento dati orbitali in corso...');
    const response = await fetch(TLE_URL);
    if (!response.ok) {
        throw new Error(`TLE fetch failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length < 3) {
        throw new Error('Risposta TLE inattesa: meno di 3 righe');
    }

    const tleLine1 = lines[1];
    const tleLine2 = lines[2];
    return { tleLine1, tleLine2 };
}

(async () => {
    try {
        const { tleLine1, tleLine2 } = await fetchISSTle();
        satrec = satellite.twoline2satrec(tleLine1, tleLine2);

        updateSatellitePosition();

        const now = new Date();
        const initialPos = satellite.eciToGeodetic(
            satellite.propagate(satrec, now).position,
            satellite.gstime(now)
        );

        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromRadians(
                initialPos.longitude,
                initialPos.latitude,
                initialPos.height * 1000 * 10
            ),
            duration: 2
        });

        setInterval(updateSatellitePosition, 1000);
    } catch (err) {
        console.error('Errore nel download dei dati orbitali:', err);
    }
})();
