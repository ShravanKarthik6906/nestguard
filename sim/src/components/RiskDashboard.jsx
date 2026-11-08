
import { useState } from 'react'

function value(number, digits = 1) {
  return Number.isFinite(number)
    ? number.toFixed(digits)
    : 'No data'
}

function DataRow({ label, children }) {
  return (
    <div className="sky-data-row">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="sky-risk-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Status({ label, ready, error }) {
  const status = ready
    ? 'Ready'
    : error
      ? 'No data'
      : 'Loading'

  return (
    <div className="sky-api-status">
      <span>{label}</span>
      <strong className={ready ? 'ready' : error ? 'unavailable' : 'loading'}>
        {status}
      </strong>
    </div>
  )
}

export default function RiskDashboard({
  location,
  weather,
  infrastructure,
  wildlife,
  airspace,
  risk,
  loading = {},
  errors = {},
  battery = 100,
  onBatteryChange,
  onRefresh,
  onLaunch,
  onAIAnalyze,
  aiAnalysis = '',
  aiLoading = false,
  aiError = '',
  route = null
}) {
  const [expandedFactors, setExpandedFactors] =
    useState(false)

  const [expandedWildlife, setExpandedWildlife] =
    useState(false)

  return (
    <aside className="sky-risk-dashboard">
      <div className="sky-dashboard-brand">
        <h2>KnowFlyZone</h2>
        <span>Flight simulator</span>
      </div>

      <Section title="Risk score">
        <div
          className={`sky-risk-summary ${
            risk?.level?.toLowerCase() || 'unknown'
          }`}
        >
          <span>{risk?.level && risk.level !== 'UNKNOWN' ? `${risk.level.charAt(0)}${risk.level.slice(1).toLowerCase()} risk` : 'Risk'}</span>

          <strong>
            {risk?.score ?? '--'}
            <small>/100</small>
          </strong>

          {risk?.driver && <b>{risk.driver}</b>}

          <p>
            {risk?.score == null ? 'Checking this spot...' : risk.source}
          </p>
        </div>

        <button
          type="button"
          className="sky-button sky-button-launch"
          onClick={onLaunch}
        >
          Fly this spot in 3D
        </button>

        {risk?.warnings?.map((warning, index) => (
          <div
            className="sky-warning"
            key={`${warning}-${index}`}
          >
            {warning}
          </div>
        ))}

        <button
          type="button"
          className="sky-button"
          onClick={() =>
            setExpandedFactors(value => !value)
          }
        >
          {expandedFactors
            ? 'Hide simulator readings'
            : 'Show simulator readings'}
        </button>

        {expandedFactors &&
          risk?.factors?.map(factor => (
            <div
              className="sky-risk-factor"
              key={factor.name}
            >
              <div className="sky-factor-header">
                <span>{factor.name}</span>

                <strong>
                  {factor.score == null
                    ? 'No data'
                    : factor.score}
                </strong>
              </div>

              <div className="sky-factor-track">
                <div
                  style={{
                    width: `${factor.score ?? 0}%`
                  }}
                />
              </div>

              <small>
                {factor.source}: {factor.detail}
              </small>
            </div>
          ))}
      </Section>

      <Section title="Spot">
        <DataRow label="Latitude">
          {location?.[1]?.toFixed(5) || 'No data'}
        </DataRow>

        <DataRow label="Longitude">
          {location?.[0]?.toFixed(5) || 'No data'}
        </DataRow>

        <button
          type="button"
          className="sky-button"
          onClick={onRefresh}
        >
          Refresh data
        </button>
      </Section>

      <Section title="Weather">
        <Status
          label="Open-Meteo"
          ready={Boolean(weather)}
          error={errors.weather}
        />

        {weather ? (
          <>
            <div className="sky-metric-grid">
              <div>
                <span>Wind</span>
                <strong>{value(weather.wind)}</strong>
                <small>m/s</small>
              </div>

              <div>
                <span>Gusts</span>
                <strong>{value(weather.gust)}</strong>
                <small>m/s</small>
              </div>

              <div>
                <span>Temperature</span>
                <strong>
                  {value(weather.temperature)}
                </strong>
                <small>°C</small>
              </div>

              <div>
                <span>Rain</span>
                <strong>
                  {value(weather.precipitation)}
                </strong>
                <small>mm</small>
              </div>
            </div>

            <DataRow label="Humidity">
              {value(weather.humidity, 0)}%
            </DataRow>

            <DataRow label="Visibility">
              {weather.visibility == null
                ? 'No data'
                : `${value(weather.visibility / 1000)} km`}
            </DataRow>

            <DataRow label="Data time">
              {weather.timestamp || 'No data'}
            </DataRow>
          </>
        ) : (
          <p className="sky-muted">
            {loading.weather
              ? 'Retrieving weather data...'
              : errors.weather ||
                'Weather data not loaded.'}
          </p>
        )}
      </Section>

      <Section title="Power lines">
        <Status
          label="OpenStreetMap"
          ready={Boolean(infrastructure)}
          error={errors.infrastructure}
        />

        {infrastructure ? (
          <>
            <div className="sky-metric-grid">
              <div>
                <span>Mapped lines</span>
                <strong>
                  {infrastructure.count}
                </strong>
              </div>

              <div>
                <span>Nearest line</span>
                <strong>
                  {infrastructure.nearest == null
                    ? '--'
                    : Math.round(
                        infrastructure.nearest
                      )}
                </strong>
                <small>meters</small>
              </div>
            </div>

            <DataRow label="Search radius">
              {infrastructure.radius} m
            </DataRow>

            <p className="sky-muted">
              OpenStreetMap coverage may be incomplete.
              Mapped line distance is not surveyed
              electrical clearance.
            </p>
          </>
        ) : (
          <p className="sky-muted">
            {loading.infrastructure
              ? 'Searching mapped power lines...'
              : errors.infrastructure ||
                'Power line data not loaded.'}
          </p>
        )}
      </Section>

      <Section title="Birds and wildlife">
        <Status
          label="iNaturalist"
          ready={Boolean(wildlife)}
          error={errors.wildlife}
        />

        {wildlife ? (
          <>
            <div className="sky-metric-grid">
              <div>
                <span>Species reported</span>
                <strong>
                  {wildlife.speciesCount}
                </strong>
              </div>

              <div>
                <span>Search radius</span>
                <strong>
                  {wildlife.radiusKm}
                </strong>
                <small>km</small>
              </div>
            </div>

            <button
              type="button"
              className="sky-button"
              onClick={() =>
                setExpandedWildlife(value => !value)
              }
            >
              {expandedWildlife
                ? 'Hide species'
                : 'Show reported species'}
            </button>

            {expandedWildlife && (
              <div className="sky-species-list">
                {wildlife.species?.length ? (
                  wildlife.species.map(species => (
                    <div
                      className="sky-species"
                      key={species.id}
                    >
                      {species.image && (
                        <img
                          src={species.image}
                          alt={species.name}
                        />
                      )}

                      <div>
                        <strong>{species.name}</strong>
                        <small>
                          {species.scientificName}
                        </small>
                        <span>
                          {species.observations}
                          {' '}historical observations
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="sky-muted">
                    No species returned.
                  </p>
                )}
              </div>
            )}

            <p className="sky-muted">
              Historical observations only.
              This does not indicate current bird
              positions or collision probability.
            </p>
          </>
        ) : (
          <p className="sky-muted">
            {loading.wildlife
              ? 'Retrieving wildlife observations...'
              : errors.wildlife ||
                'Wildlife data not loaded.'}
          </p>
        )}
      </Section>

      <Section title="Airspace">
        <div className="sky-warning">
          Airspace not checked. Use B4UFLY.
        </div>

        <p className="sky-muted">
          {airspace?.message ||
            'FAA airspace authorization has not been verified.'}
        </p>

        <a
          href={
            airspace?.officialResource ||
            'https://www.faa.gov/uas/getting_started/where_can_i_fly'
          }
          target="_blank"
          rel="noopener noreferrer"
          className="sky-external-link"
        >
          FAA drone flight resources
        </a>
      </Section>

      <Section title="Simulated drone">
        <label className="sky-range-label">
          Starting battery: {battery}%

          <input
            type="range"
            min="10"
            max="100"
            value={battery}
            onChange={event =>
              onBatteryChange?.(
                Number(event.target.value)
              )
            }
          />
        </label>
      </Section>

      <Section title="Flight route">
        {route ? (
          <>
            <DataRow label="Distance">
              {value(route.distanceMeters)} m
            </DataRow>

            <DataRow label="Estimated time">
              {value(route.estimatedSeconds, 0)} s
            </DataRow>

            <DataRow label="Estimated battery use">
              {value(route.batteryUsePercent)}%
            </DataRow>

            <p className="sky-muted">
              Candidate route only. Obstacles,
              airspace, and clearances have not
              been fully verified.
            </p>
          </>
        ) : (
          <p className="sky-muted">
            Select a destination on the map
            to generate a candidate route.
          </p>
        )}
      </Section>

      <Section title="Gemini">
        <button
          type="button"
          className="sky-button sky-button-ai"
          onClick={onAIAnalyze}
          disabled={aiLoading}
        >
          {aiLoading
            ? 'Asking Gemini...'
            : 'Explain this flight with Gemini'}
        </button>

        {aiError && (
          <div className="sky-warning">
            {aiError}
          </div>
        )}

        {aiAnalysis && (
          <div className="sky-ai-output">
            <div className="sky-ai-output-title">
              Gemini
            </div>

            <div className="sky-ai-output-text">
              {aiAnalysis}
            </div>
          </div>
        )}

        <p className="sky-muted">
          AI explanations are informational and
          cannot authorize a real-world flight.
        </p>
      </Section>

      <p className="sky-muted sky-disclaimer">
        KnowFlyZone prototype. Data may be
        incomplete or delayed. Practice only,
        not a validated aviation safety system.
      </p>
    </aside>
  )
}
