import { Component } from 'react'
import { loadPreferences, savePreferences } from './preferences'
import fetchDestinations from './fetch-destinations'
import conditionallyLoadAnalytics from './analytics'
import { Destination, CategoryPreferences } from '../types'

/**
 * Diffs the current consent preferences against the list of destinations
 * returned for a given set of write keys.
 *
 * This is especially useful when newer destinations are added to a Source,
 * forcing the consent manager to re-request consent for the new Destinations.
 *
 * @param destinations The list of destinations connected to a list of write keys
 * @param destinationPreferences The user preferences
 */
function destinationsWithoutConsent(
  destinations: Destination[],
  destinationPreferences?: CategoryPreferences
) {
  if (!destinationPreferences) {
    return destinations
  }

  return destinations.filter(d => destinationPreferences[d.id] === undefined)
}

interface Props {
  /** Your Segment Write key for your website */
  writeKey: string

  /** A list of other write keys you may want to provide */
  otherWriteKeys?: string[]

  cookieDomain?: string

  /**
   * An initial selection of Preferences
   */
  initialPreferences?: CategoryPreferences

  /**
   * Provide a function to define whether or not consent should be required
   */
  shouldRequireConsent?: () => Promise<boolean> | boolean

  /**
   * Render props for the Consent Manager builder
   */
  children: (props: RenderProps) => React.ReactElement

  /**
   * Allows for customizing how to show different categories of consent.
   */
  mapCustomPreferences?: (
    destinations: Destination[],
    preferences: CategoryPreferences
  ) => { destinationPreferences: CategoryPreferences; customPreferences: CategoryPreferences }

  /**
   * A callback for dealing with errors in the Consent Manager
   */
  onError?: (err: Error) => void | Promise<void>
}

interface RenderProps {
  destinations: Destination[]
  newDestinations: Destination[]
  preferences: CategoryPreferences
  isConsentRequired: boolean
  setPreferences: (newPreferences: CategoryPreferences) => void
  resetPreferences: () => void
  saveConsent: (newPreferences?: CategoryPreferences | boolean, shouldReload?: boolean) => void
}

interface State {
  isLoading: boolean
  destinations: Destination[]
  newDestinations: Destination[]
  preferences?: CategoryPreferences
  isConsentRequired: boolean
}

export default class ConsentManagerBuilder extends Component<Props, State> {
  static displayName = 'ConsentManagerBuilder'

  static defaultProps = {
    otherWriteKeys: [],
    onError: undefined,
    shouldRequireConsent: () => true,
    initialPreferences: {}
  }

  state = {
    isLoading: true,
    destinations: [],
    newDestinations: [],
    preferences: {},
    isConsentRequired: true
  }

  render() {
    const { children } = this.props
    const { isLoading, destinations, preferences, newDestinations, isConsentRequired } = this.state

    if (isLoading) {
      return null
    }

    return children({
      destinations,
      newDestinations,
      preferences,
      isConsentRequired,
      setPreferences: this.handleSetPreferences,
      resetPreferences: this.handleResetPreferences,
      saveConsent: this.handleSaveConsent
    })
  }

  async componentDidMount() {
    const { onError } = this.props
    if (onError && typeof onError === 'function') {
      try {
        await this.initialise()
      } catch (e) {
        await onError(e)
      }
    } else {
      await this.initialise()
    }
  }

  initialise = async () => {
    const {
      writeKey,
      otherWriteKeys = ConsentManagerBuilder.defaultProps.otherWriteKeys,
      shouldRequireConsent = ConsentManagerBuilder.defaultProps.shouldRequireConsent,
      initialPreferences,
      mapCustomPreferences
    } = this.props
    // TODO: add option to run mapCustomPreferences on load so that the destination preferences automatically get updated
    let { destinationPreferences = {}, customPreferences } = loadPreferences()

    const [isConsentRequired, destinations] = await Promise.all([
      shouldRequireConsent(),
      fetchDestinations([writeKey, ...otherWriteKeys])
    ])

    const newDestinations = destinationsWithoutConsent(destinations, destinationPreferences)

    let preferences: CategoryPreferences | undefined
    if (mapCustomPreferences) {
      preferences = customPreferences || initialPreferences || {}

      const hasInitialPreferenceToTrue = Object.values(initialPreferences || {}).some(Boolean)
      const emptyCustomPreferecences = Object.values(customPreferences || {}).every(
        v => v === null || v === undefined
      )

      if (hasInitialPreferenceToTrue && emptyCustomPreferecences) {
        const mapped = mapCustomPreferences(destinations, preferences)
        destinationPreferences = mapped.destinationPreferences
        customPreferences = mapped.customPreferences
      }
    } else {
      preferences = destinationPreferences || initialPreferences
    }

    conditionallyLoadAnalytics({
      writeKey,
      destinations,
      destinationPreferences,
      isConsentRequired
    })

    this.setState({
      isLoading: false,
      destinations,
      newDestinations,
      preferences,
      isConsentRequired
    })
  }

  handleSetPreferences = (newPreferences: CategoryPreferences) => {
    this.setState(prevState => {
      const { destinations, preferences: existingPreferences = {} } = prevState
      const preferences = this.mergePreferences(destinations, existingPreferences, newPreferences)
      return { ...prevState, preferences }
    })
  }

  handleResetPreferences = () => {
    const { initialPreferences, mapCustomPreferences } = this.props
    const { destinationPreferences, customPreferences } = loadPreferences()

    let preferences: CategoryPreferences | undefined
    if (mapCustomPreferences) {
      preferences = customPreferences || initialPreferences
    } else {
      preferences = destinationPreferences || initialPreferences
    }

    this.setState({ preferences })
  }

  handleSaveConsent = (
    newPreferences: CategoryPreferences | undefined | boolean,
    shouldReload: boolean
  ) => {
    const { writeKey, cookieDomain, mapCustomPreferences } = this.props

    this.setState(prevState => {
      const { destinations, preferences: existingPreferences = {}, isConsentRequired } = prevState

      let preferences = this.mergePreferences(destinations, existingPreferences, newPreferences)

      let destinationPreferences: CategoryPreferences
      let customPreferences: CategoryPreferences | undefined

      if (mapCustomPreferences) {
        const custom = mapCustomPreferences(destinations, preferences)
        destinationPreferences = custom.destinationPreferences
        customPreferences = custom.customPreferences

        if (customPreferences) {
          // Allow the customPreferences to be updated from mapCustomPreferences
          preferences = customPreferences
        } else {
          // Make returning the customPreferences from mapCustomPreferences optional
          customPreferences = preferences
        }
      } else {
        destinationPreferences = preferences
      }

      const newDestinations = destinationsWithoutConsent(destinations, destinationPreferences)

      savePreferences({ destinationPreferences, customPreferences, cookieDomain })
      conditionallyLoadAnalytics({
        writeKey,
        destinations,
        destinationPreferences,
        isConsentRequired,
        shouldReload
      })

      return { ...prevState, destinationPreferences, preferences, newDestinations }
    })
  }

  mergePreferences = (
    destinations: Destination[],
    existingPreferences: CategoryPreferences,
    newPreferences?: CategoryPreferences | boolean
  ) => {
    let preferences: CategoryPreferences

    if (typeof newPreferences === 'boolean') {
      preferences = destinations.reduce((prefs, destination) => {
        return {
          ...prefs,
          [destination.id]: newPreferences
        }
      }, {})
    } else {
      preferences = {
        ...existingPreferences,
        ...(newPreferences || {})
      }
    }
    return preferences
  }
}
