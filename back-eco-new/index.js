import { elements } from "./ui/domElements.js";
import { showModal, generateReceipt } from "./ui/modalHandler.js";
import {
  setRendererData,
  renderProductList,
  renderRentalHistory,
  renderSelectedItems,
  renderProductSelection,
  updateFinancialSummaries,
  updateRentalFormSummary,
} from "./ui/renderer.js";
import * as auth from "./services/authService.js";
import * as db from "./services/firestoreService.js";

let products = [];
let rentals = [];
let selectedProductsForRental = {};
let selectedProductsForEdit = {};
let currentEditRentalId = null;
let unsubscribeProducts = null;
let unsubscribeRentals = null;

const init = () => {
  auth.onAuthStateChanged((user) => {
    if (user) handleLogin();
    else handleLogout();
  });
  setupEventListeners();
};

const handleLogin = () => {
  const user = firebase.auth().currentUser;
  if (!user) return;

  elements.userName.textContent = user.displayName || user.email;
  elements.appContainer.classList.remove("hidden");
  elements.loginContainer.classList.add("hidden");
  elements.loadingOverlay.classList.add("hidden");
  elements.authContainer.classList.remove("hidden");

  if (unsubscribeProducts) unsubscribeProducts();
  if (unsubscribeRentals) unsubscribeRentals();

  unsubscribeProducts = db.onProductsChange((snapshot) => {
    products = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    updateAppData();
  });

  unsubscribeRentals = db.onRentalsChange((snapshot) => {
    rentals = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    updateAppData();
  });
};

const handleLogout = () => {
  if (unsubscribeProducts) unsubscribeProducts();
  if (unsubscribeRentals) unsubscribeRentals();

  products = [];
  rentals = [];
  selectedProductsForRental = {};
  elements.appContainer.classList.add("hidden");
  elements.loginContainer.classList.remove("hidden");
  elements.loadingOverlay.classList.add("hidden");
  elements.authContainer.classList.add("hidden");
  updateAppData();
};

const updateAppData = () => {
  setRendererData(products, rentals);
  renderProductList();
  renderRentalHistory(elements.rentalSearchInput.value);
  updateFinancialSummaries();
  updateCreateRentalUI();
};

const updateCreateRentalUI = () => {
  renderProductSelection(
    elements.productSelectionContainer,
    selectedProductsForRental,
    null,
    elements.rentalDateInput.value,
    elements.returnDateInput.value
  );
  renderSelectedItems(
    elements.selectedItemsContainer,
    selectedProductsForRental,
    null,
    elements.rentalDateInput.value,
    elements.returnDateInput.value
  );
  updateRentalFormSummary(selectedProductsForRental);
};

const updateEditRentalUI = () => {
  renderProductSelection(
    elements.editProductSelectionContainer,
    selectedProductsForEdit,
    currentEditRentalId,
    elements.editRentalDateInput.value,
    elements.editReturnDateInput.value
  );
  renderSelectedItems(
    elements.editSelectedItemsContainer,
    selectedProductsForEdit,
    currentEditRentalId,
    elements.editRentalDateInput.value,
    elements.editReturnDateInput.value
  );
};

const setupEventListeners = () => {
  elements.googleLoginBtn.addEventListener("click", auth.signInWithGoogle);
  elements.logoutBtn.addEventListener("click", auth.signOut);

  elements.productForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const product = {
      name: elements.productNameInput.value.trim(),
      quantity: parseInt(elements.productQuantityInput.value),
      price: parseFloat(elements.productPriceInput.value),
    };
    if (
      !product.name ||
      isNaN(product.quantity) ||
      product.quantity <= 0 ||
      isNaN(product.price) ||
      product.price <= 0
    ) {
      showModal(
        `<p class="text-red-400">Preencha todos os campos do produto corretamente.</p>`
      );
      return;
    }
    await db.addProduct(product);
    showModal(`<p class="text-emerald-400">Produto salvo!</p>`);
    elements.productForm.reset();
  });

  elements.productList.addEventListener("click", (e) => {
    const editBtn = e.target.closest(".edit-product-btn");
    const deleteBtn = e.target.closest(".delete-product-btn");

    if (editBtn) {
      const product = products.find((p) => p.id === editBtn.dataset.id);
      elements.editProductIdInput.value = product.id;
      elements.editProductNameInput.value = product.name;
      elements.editProductQuantityInput.value = product.quantity;
      elements.editProductPriceInput.value = product.price;
      elements.editProductModal.classList.remove("hidden");
    }
    if (deleteBtn) {
      const productId = deleteBtn.dataset.id;
      const isProductInUse = rentals.some(
        (rental) => rental.items && rental.items[productId]
      );
      if (isProductInUse) {
        showModal(
          `<p class="text-amber-400">Este produto não pode ser apagado pois está sendo usado em uma ou mais locações.</p>`
        );
        return;
      }
      showModal(`<p>Tem certeza que deseja apagar este produto?</p>`, () =>
        db.deleteProduct(productId)
      );
    }
  });

  elements.editProductForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = elements.editProductIdInput.value;
    const updatedProduct = {
      name: elements.editProductNameInput.value.trim(),
      quantity: parseInt(elements.editProductQuantityInput.value),
      price: parseFloat(elements.editProductPriceInput.value),
    };
    await db.updateProduct(id, updatedProduct);
    elements.editProductModal.classList.add("hidden");
  });
  elements.cancelEditBtn.addEventListener("click", () =>
    elements.editProductModal.classList.add("hidden")
  );

  elements.productSelectionContainer.addEventListener("click", (e) => {
    const productCard = e.target.closest("[data-product-id]");
    if (productCard) {
      const productId = productCard.dataset.productId;
      selectedProductsForRental[productId] = 1;
      updateCreateRentalUI();
    }
  });

  elements.selectedItemsContainer.addEventListener("input", (e) => {
    if (e.target.classList.contains("quantity-input")) {
      const productId = e.target.dataset.productId;
      const quantity = parseInt(e.target.value);
      if (!isNaN(quantity)) {
        if (quantity > 0) {
          selectedProductsForRental[productId] = quantity;
        } else {
          delete selectedProductsForRental[productId];
        }
        updateCreateRentalUI();
      }
    }
  });

  elements.selectedItemsContainer.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".remove-item-btn");
    if (removeBtn) {
      const productId = removeBtn.closest(".selected-item-card").dataset
        .productId;
      delete selectedProductsForRental[productId];
      updateCreateRentalUI();
    }
  });

  elements.rentalDateInput.addEventListener("change", updateCreateRentalUI);
  elements.returnDateInput.addEventListener("change", updateCreateRentalUI);
  elements.rentalDiscountInput.addEventListener("input", () =>
    updateRentalFormSummary(selectedProductsForRental)
  );
  elements.rentalMachineFeeInput.addEventListener("input", () =>
    updateRentalFormSummary(selectedProductsForRental)
  );

  elements.rentalForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rental = {
      client: elements.clientNameInput.value.trim(),
      address: elements.rentalAddressInput.value.trim(),
      date: elements.rentalDateInput.value,
      returnDate: elements.returnDateInput.value,
      discount: parseFloat(elements.rentalDiscountInput.value) || 0,
      machineFee: parseFloat(elements.rentalMachineFeeInput.value) || 0,
      items: selectedProductsForRental,
      paymentInfo: {
        totalInstallments:
          parseInt(elements.rentalInstallmentsInput.value) || 1,
        paidInstallments: 0,
      },
    };

    if (
      !rental.client ||
      !rental.date ||
      !rental.returnDate ||
      Object.keys(rental.items).length === 0
    ) {
      showModal(
        `<p class="text-red-400">Preencha os campos obrigatórios e selecione itens.</p>`
      );
      return;
    }

    await db.addRental(rental);
    showModal(`<p class="text-emerald-400">Locação salva!</p>`);
    elements.rentalForm.reset();
    selectedProductsForRental = {};
    updateCreateRentalUI();
  });

  elements.editProductSelectionContainer.addEventListener("click", (e) => {
    const productCard = e.target.closest("[data-product-id]");
    if (productCard) {
      const productId = productCard.dataset.productId;
      selectedProductsForEdit[productId] = 1;
      updateEditRentalUI();
    }
  });

  elements.editSelectedItemsContainer.addEventListener("input", (e) => {
    if (e.target.classList.contains("quantity-input")) {
      const productId = e.target.dataset.productId;
      const quantity = parseInt(e.target.value);
      if (!isNaN(quantity)) {
        if (quantity > 0) {
          selectedProductsForEdit[productId] = quantity;
        } else {
          delete selectedProductsForEdit[productId];
        }
        updateEditRentalUI();
      }
    }
  });

  elements.editSelectedItemsContainer.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".remove-item-btn");
    if (removeBtn) {
      const productId = removeBtn.closest(".selected-item-card").dataset
        .productId;
      delete selectedProductsForEdit[productId];
      updateEditRentalUI();
    }
  });

  elements.editRentalDateInput.addEventListener("change", updateEditRentalUI);
  elements.editReturnDateInput.addEventListener("change", updateEditRentalUI);

  elements.editRentalForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rentalId = elements.editRentalIdInput.value;
    const originalRental = rentals.find((r) => r.id === rentalId);

    const updatedRental = {
      client: elements.editClientNameInput.value.trim(),
      address: elements.editRentalAddressInput.value.trim(),
      date: elements.editRentalDateInput.value,
      returnDate: elements.editReturnDateInput.value,
      discount: parseFloat(elements.editRentalDiscountInput.value) || 0,
      machineFee: parseFloat(elements.editRentalMachineFeeInput.value) || 0,
      items: selectedProductsForEdit,
      paymentInfo: {
        totalInstallments:
          parseInt(elements.editRentalInstallmentsInput.value) || 1,
        paidInstallments: originalRental.paymentInfo.paidInstallments,
      },
    };

    await db.updateRental(rentalId, updatedRental);
    showModal(`<p class="text-emerald-400">Locação atualizada!</p>`);
    elements.editRentalModal.classList.add("hidden");
  });

  elements.cancelEditRentalBtn.addEventListener("click", () => {
    elements.editRentalModal.classList.add("hidden");
  });

  elements.rentalSearchInput.addEventListener("input", (e) =>
    renderRentalHistory(e.target.value)
  );

  elements.rentalHistoryList.addEventListener("click", (e) => {
    const target = e.target.closest("button");
    if (!target) return;

    const rentalId = target.dataset.id;
    const rental = rentals.find((r) => r.id === rentalId);
    if (!rental) return;

    if (target.classList.contains("add-payment-btn")) {
      elements.rentalIdForPaymentInput.value = rentalId;
      elements.paymentModal.classList.remove("hidden");
      elements.paymentAmountInput.focus();
    }
    if (target.classList.contains("delete-payment-btn")) {
      const timestamp = parseInt(target.dataset.paymentTimestamp);
      const paymentToDelete = rental.payments.find((p) => {
        const pTimestamp =
          p.date.seconds || Math.floor(p.date.getTime() / 1000);
        return pTimestamp === timestamp;
      });

      if (paymentToDelete) {
        showModal(`<p>Tem certeza que deseja apagar este pagamento?</p>`, () =>
          db.deletePayment(rentalId, paymentToDelete)
        );
      }
    }
    if (target.classList.contains("receipt-btn")) {
      generateReceipt(rental, products);
    }
    if (target.classList.contains("delete-rental-btn")) {
      showModal(
        `<p>Apagar locação de <strong>${rental.client}</strong>?</p>`,
        () => db.deleteRental(rentalId)
      );
    }
    if (target.classList.contains("edit-rental-btn")) {
      currentEditRentalId = rental.id;
      selectedProductsForEdit = { ...rental.items };
      elements.editRentalIdInput.value = rental.id;
      elements.editClientNameInput.value = rental.client;
      elements.editRentalAddressInput.value = rental.address || "";
      elements.editRentalDateInput.value = rental.date;
      elements.editReturnDateInput.value = rental.returnDate;
      elements.editRentalDiscountInput.value = rental.discount || 0;
      elements.editRentalMachineFeeInput.value = rental.machineFee || 0;
      elements.editRentalInstallmentsInput.value =
        rental.paymentInfo.totalInstallments || 1;
      updateEditRentalUI();
      elements.editRentalModal.classList.remove("hidden");
    }
    if (target.classList.contains("installment-circle-btn")) {
      const installmentIndex = parseInt(target.dataset.installmentIndex);
      let { paidInstallments } = rental.paymentInfo;
      if (installmentIndex === paidInstallments + 1) {
        paidInstallments++;
      } else if (installmentIndex === paidInstallments) {
        paidInstallments--;
      }
      db.updateRentalPayment(rentalId, paidInstallments);
    }
  });

  elements.paymentForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rentalId = elements.rentalIdForPaymentInput.value;
    const amount = elements.paymentAmountInput.value;
    if (rentalId && amount > 0) {
      await db.addPayment(rentalId, amount);
      elements.paymentModal.classList.add("hidden");
      elements.paymentForm.reset();
    }
  });

  elements.cancelPaymentBtn.addEventListener("click", () => {
    elements.paymentModal.classList.add("hidden");
    elements.paymentForm.reset();
  });

  elements.showHelpBtn.addEventListener("click", () =>
    elements.helpModal.classList.remove("hidden")
  );
  elements.closeHelpBtn.addEventListener("click", () =>
    elements.helpModal.classList.add("hidden")
  );

  elements.toggleEditProductSelectionBtn.addEventListener("click", () => {
    elements.editProductSelectionWrapper.classList.toggle("hidden");
    elements.toggleEditProductIcon.classList.toggle("rotate-180");
  });

  document.querySelectorAll(".calendar-trigger").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const dateInput = trigger
        .closest(".input-wrapper")
        .querySelector('input[type="date"]');
      if (dateInput?.showPicker) {
        try {
          dateInput.showPicker();
        } catch (error) {
          console.warn("showPicker() não é suportado neste navegador.", error);
        }
      }
    });
  });

  // Backup Listeners
  elements.exportBackupBtn.addEventListener("click", () => {
    const dataToExport = {
      products: products,
      rentals: rentals,
    };
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const dataBlob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(dataBlob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `backup-locacoes-${
      new Date().toISOString().split("T")[0]
    }.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showModal(`<p class="text-emerald-400">Backup exportado com sucesso!</p>`);
  });

  elements.importBackupBtn.addEventListener("click", () =>
    elements.backupFileInput.click()
  );

  elements.backupFileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const importedData = JSON.parse(e.target.result);
        if (importedData.products && importedData.rentals) {
          showModal(
            `<p class="text-amber-400">Atenção: Isso adicionará os dados do arquivo ao sistema. Dados existentes não serão apagados. Deseja continuar?</p>`,
            async () => {
              elements.loadingOverlay.classList.remove("hidden");
              for (const product of importedData.products) {
                const { id, ...productData } = product;
                await db.addProduct(productData);
              }
              for (const rental of importedData.rentals) {
                const { id, ...rentalData } = rental;
                await db.addRental(rentalData);
              }
              elements.loadingOverlay.classList.add("hidden");
              showModal(
                `<p class="text-emerald-400">Dados importados com sucesso!</p>`
              );
            }
          );
        } else {
          showModal(`<p class="text-red-400">Arquivo de backup inválido.</p>`);
        }
      } catch (error) {
        showModal(
          `<p class="text-red-400">Erro ao ler o arquivo de backup.</p>`
        );
        console.error(error);
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  });
};

init();
