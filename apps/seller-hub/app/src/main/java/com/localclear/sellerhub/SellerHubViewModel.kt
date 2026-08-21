package com.localclear.sellerhub

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

data class SellerHubUiState(
    val paired: Boolean = false,
    val deviceId: String? = null,
    val busy: Boolean = false,
    val keepAwake: Boolean = false,
    val receivedCommands: Int = 0,
    val completedCommands: Int = 0,
    val needsAction: Int = 0,
    val lastState: String = "Not synced",
    val lastSyncAt: String? = null,
    val error: String? = null,
)

class SellerHubViewModel(application: Application) : AndroidViewModel(application) {
    private val sessionStore = SessionStore(application)
    private val keyStore = DeviceKeyStore()
    private val executor = CommandExecutor(application)
    private val _state = MutableStateFlow(
        sessionStore.load()?.let { session ->
            SellerHubUiState(paired = true, deviceId = session.deviceId)
        } ?: SellerHubUiState(),
    )
    val state: StateFlow<SellerHubUiState> = _state.asStateFlow()

    init {
        if (_state.value.paired) SellerHubWorker.schedule(application)
    }

    fun pair(scannedValue: String) {
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            runCatching {
                withContext(Dispatchers.IO) {
                    PairingClient(keyStore).complete(scannedValue)
                }
            }.onSuccess { result ->
                sessionStore.save(result.session)
                SellerHubWorker.schedule(getApplication())
                _state.update {
                    it.copy(
                        paired = true,
                        deviceId = result.session.deviceId,
                        busy = false,
                        lastState = "Paired",
                    )
                }
                syncNow()
            }.onFailure { error ->
                _state.update {
                    it.copy(
                        busy = false,
                        error = error.message ?: "Pairing failed",
                    )
                }
            }
        }
    }

    fun syncNow() {
        val session = sessionStore.load() ?: return
        if (_state.value.busy) return
        viewModelScope.launch {
            _state.update { it.copy(busy = true, error = null) }
            runCatching {
                withContext(Dispatchers.IO) { executor.sync(session) }
            }.onSuccess { result ->
                _state.update {
                    it.copy(
                        busy = false,
                        receivedCommands = result.received,
                        completedCommands = result.completed,
                        needsAction = result.needsAction,
                        lastState = result.lastState,
                        lastSyncAt = Instant.now().toString(),
                    )
                }
            }.onFailure { error ->
                _state.update {
                    it.copy(
                        busy = false,
                        error = error.message ?: "Sync failed",
                        lastSyncAt = Instant.now().toString(),
                    )
                }
            }
        }
    }

    fun setKeepAwake(value: Boolean) {
        _state.update { it.copy(keepAwake = value) }
    }

    fun clearLocalData() {
        executor.clearLocalData()
        sessionStore.clear()
        keyStore.clear()
        SellerHubWorker.cancel(getApplication())
        _state.value = SellerHubUiState()
    }
}
